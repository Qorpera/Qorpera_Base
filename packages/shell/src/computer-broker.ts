/**
 * Kernel side of the staff computer lane.
 *
 * The agent child is offline. This broker owns a visible Google Chrome profile
 * through Playwright and exposes a deliberately small surface over the RPC pipe.
 * Initial navigation is constrained to an owned connector's registration
 * origin. The kernel, not the model, verifies that a handoff page contains a
 * real sign-in, identity, MFA, or consent boundary. The managed profile remains
 * open at that boundary so the founder can finish privately and the agent can
 * resume public setup in the same browser afterward.
 */

import type { KernelIntentCapability } from "@qorpera/pi-protocol";
import { type BrowserContext, chromium, type Page } from "playwright-core";

const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REF_PATTERN = /^q[1-9][0-9]{0,4}$/;
const ACTIONS = new Set([
	"open",
	"snapshot",
	"click",
	"fill",
	"press",
	"screenshot",
	"read_public_value",
	"store_secret",
	"handoff",
]);
const KEYS = new Set(["Tab", "Enter", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);
const SECRET_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_INTENT_LIFETIME_MS = 4 * 60 * 60 * 1000;
const MAX_URL_BYTES = 8 * 1024;
const MAX_FILL_BYTES = 16 * 1024;
const MAX_ACTIONS_PER_TURN = 128;

interface ComputerRequestFrame {
	type: "qorpera_computer_request";
	requestId: string;
	action:
		| "open"
		| "snapshot"
		| "click"
		| "fill"
		| "press"
		| "screenshot"
		| "read_public_value"
		| "store_secret"
		| "handoff";
	url?: string;
	ref?: string;
	text?: string;
	key?: string;
	secretName?: string;
	intent: KernelIntentCapability;
}

interface ComputerSnapshot {
	url: string;
	title: string;
	snapshot: string;
	handoffReady: boolean;
}

interface ComputerIntentState {
	capability: KernelIntentCapability;
	actions: number;
	status: "active" | "ended";
	expiryTimer: NodeJS.Timeout;
}

export interface ComputerObservation {
	requestId: string;
	action: ComputerRequestFrame["action"];
	url?: string;
	status: "started" | "completed" | "failed" | "denied" | "handoff";
	detail?: string;
}

export interface ComputerBroker {
	authorizeIntent: (capability: KernelIntentCapability) => boolean;
	handleFrame: (value: unknown, send: (frame: object) => void) => boolean;
	handoffReady: () => boolean;
	openPrivateProviderUrl: (url: string) => Promise<void>;
	endTurn: () => void;
	release: () => void;
}

type ChromeLauncher = (profilePath: string) => Promise<BrowserContext>;

function exactKeys(value: object, allowed: readonly string[]): boolean {
	return Object.keys(value).every((key) => allowed.includes(key));
}

function validIntentShape(value: unknown): value is KernelIntentCapability {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const intent = value as Record<string, unknown>;
	return (
		typeof intent.nonce === "string" &&
		REQUEST_ID_PATTERN.test(intent.nonce) &&
		typeof intent.sessionId === "string" &&
		typeof intent.requestHash === "string" &&
		typeof intent.attended === "boolean" &&
		typeof intent.issuedAt === "string" &&
		typeof intent.expiresAt === "string" &&
		typeof intent.signature === "string" &&
		!!intent.budget &&
		typeof intent.budget === "object"
	);
}

function parsedFrame(value: unknown): ComputerRequestFrame | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const frame = value as Record<string, unknown>;
	if (
		!exactKeys(frame, ["type", "requestId", "action", "url", "ref", "text", "key", "secretName", "intent"]) ||
		frame.type !== "qorpera_computer_request" ||
		typeof frame.requestId !== "string" ||
		!REQUEST_ID_PATTERN.test(frame.requestId) ||
		typeof frame.action !== "string" ||
		!ACTIONS.has(frame.action) ||
		!validIntentShape(frame.intent) ||
		(frame.url !== undefined &&
			(typeof frame.url !== "string" || Buffer.byteLength(frame.url, "utf-8") > MAX_URL_BYTES)) ||
		(frame.ref !== undefined && (typeof frame.ref !== "string" || !REF_PATTERN.test(frame.ref))) ||
		(frame.text !== undefined &&
			(typeof frame.text !== "string" || Buffer.byteLength(frame.text, "utf-8") > MAX_FILL_BYTES)) ||
		(frame.key !== undefined && (typeof frame.key !== "string" || !KEYS.has(frame.key))) ||
		(frame.secretName !== undefined &&
			(typeof frame.secretName !== "string" || !SECRET_NAME_PATTERN.test(frame.secretName))) ||
		(frame.action === "open") !== (frame.url !== undefined) ||
		(frame.action === "click" ||
			frame.action === "fill" ||
			frame.action === "read_public_value" ||
			frame.action === "store_secret") !==
			(frame.ref !== undefined) ||
		(frame.action === "fill") !== (frame.text !== undefined) ||
		(frame.action === "press") !== (frame.key !== undefined) ||
		(frame.action === "store_secret") !== (frame.secretName !== undefined)
	) {
		return undefined;
	}
	return frame as unknown as ComputerRequestFrame;
}

function recognizedProtectedBoundary(snapshot: ComputerSnapshot): boolean {
	if (snapshot.handoffReady) return true;
	let url: URL;
	try {
		url = new URL(snapshot.url);
	} catch {
		return false;
	}
	if (url.protocol !== "https:") return false;
	const visibleSignIn = /(?:^|\n)Visible text:\n[\s\S]*\bsign in\b/i.test(snapshot.snapshot);
	const identityField =
		/\b(?:input|edit)(?::(?:email|text))?\s+["'](?:email|email or phone|phone|username|user id)/i.test(
			snapshot.snapshot,
		);
	const publicBlocker =
		/\bbutton\s+["'](?:accept all|accept selected|close settings|manage cookies|cookie settings|privacy settings)["']/i.test(
			snapshot.snapshot,
		);
	return (
		!publicBlocker &&
		url.hostname.toLowerCase() === "accounts.google.com" &&
		(/\bsign in\b/i.test(snapshot.title) || /\/(?:v\d+\/)?signin(?:\/|$)/i.test(url.pathname)) &&
		visibleSignIn &&
		identityField
	);
}

const SNAPSHOT_SCRIPT = `(() => {
	const visible = (element) => {
		const style = getComputedStyle(element);
		const box = element.getBoundingClientRect();
		return style.visibility !== "hidden" && style.display !== "none" && box.width > 0 && box.height > 0;
	};
	const controls = [...document.querySelectorAll("a[href],button,input,select,textarea,[role=button],[role=link],[tabindex]")]
		.filter(visible)
		.slice(0, 160);
	let counter = Number(window.__qorperaRefCounter || 0);
	const ancestorText = (element) => {
		const parts = [];
		let current = element.parentElement;
		for (let depth = 0; current && depth < 5; depth += 1, current = current.parentElement) {
			const content = (current.innerText || "").replace(/\\s+/g, " ").trim();
			if (content && content.length <= 4000 && !parts.includes(content)) parts.push(content);
		}
		return parts.join(" ");
	};
	const secretValues = [];
	const lines = controls.map((element) => {
		let ref = element.getAttribute("data-qorpera-ref");
		if (!ref) {
			counter += 1;
			ref = "q" + counter;
			element.setAttribute("data-qorpera-ref", ref);
		}
		const tag = element.tagName.toLowerCase();
		const role = element.getAttribute("role") || (tag === "a" ? "link" : tag === "button" ? "button" : tag);
		const inputType = tag === "input" ? (element.getAttribute("type") || "text") : "";
		let name = (element.getAttribute("aria-label") || element.getAttribute("placeholder") || element.innerText || element.getAttribute("name") || "")
			.replace(/\\s+/g, " ")
			.trim()
			.slice(0, 160);
		const value = tag === "input" || tag === "textarea" ? String(element.value || "").trim() : "";
		const copied = name.match(/^copy to clipboard:\\s*(.+)$/i)?.[1]?.trim() || "";
		const context = [
			element.getAttribute("aria-label") || "",
			element.getAttribute("name") || "",
			element.getAttribute("id") || "",
			element.getAttribute("placeholder") || "",
			ancestorText(element),
		].join(" ").toLowerCase();
		const secretValue = copied || value;
		const generatedSecret = Boolean(secretValue) && /(?:client|api|application)[ _-]*secret|secret[ _-]*(?:key|value)|access[ _-]*token|private[ _-]*key/.test(context);
		const generatedPublicValue = Boolean(secretValue) && !generatedSecret && /(?:client|application|app)[ _-]*(?:id|identifier)/.test(context);
		if (generatedSecret) {
			secretValues.push(secretValue);
			element.setAttribute("data-qorpera-generated-secret", "true");
			element.removeAttribute("data-qorpera-public-value");
			name = /client[ _-]*secret/.test(context)
				? "Store generated client secret (value hidden)"
				: "Store generated secret (value hidden)";
		} else if (generatedPublicValue) {
			secretValues.push(secretValue);
			element.removeAttribute("data-qorpera-generated-secret");
			element.setAttribute("data-qorpera-public-value", "true");
			name = "Read generated public client ID";
		} else {
			element.removeAttribute("data-qorpera-generated-secret");
			element.removeAttribute("data-qorpera-public-value");
			if (copied && copied.length >= 8) {
				secretValues.push(copied);
				name = "Copy value (hidden)";
			}
		}
		const href = tag === "a" ? element.getAttribute("href") : "";
		return "[" + ref + "] " + role + (inputType ? ":" + inputType : "") + (name ? " \\"" + name + "\\"" : "") + (href ? " -> " + href : "");
	});
	window.__qorperaRefCounter = counter;
	const sensitive = controls.some((element) => {
		if (element.tagName.toLowerCase() !== "input") return false;
		const type = (element.getAttribute("type") || "text").toLowerCase();
		const autocomplete = (element.getAttribute("autocomplete") || "").toLowerCase();
		const identity = [element.getAttribute("name"), element.getAttribute("id"), element.getAttribute("placeholder"), element.getAttribute("aria-label")]
			.filter(Boolean)
			.join(" ")
			.toLowerCase();
		return type === "password" || ["current-password", "new-password", "one-time-code"].includes(autocomplete) || /(password|passcode|one.?time|otp|mfa|verification.?code)/.test(identity);
	});
	const authCopy = (document.body.innerText || "").slice(0, 30000).toLowerCase();
	const username = controls.some((element) => {
		if (element.tagName.toLowerCase() !== "input") return false;
		const type = (element.getAttribute("type") || "text").toLowerCase();
		const identity = [element.getAttribute("name"), element.getAttribute("id"), element.getAttribute("placeholder"), element.getAttribute("aria-label")]
			.filter(Boolean)
			.join(" ")
			.toLowerCase();
		const context = (element.closest("form,dialog,[role=dialog],[aria-modal=true]")?.innerText || "").toLowerCase();
		return /(username|user.?id|account.?id)/.test(identity) || ((type === "email" || /email/.test(identity)) && /(sign in|signin|log in|login|access your account|continue)/.test(context));
	});
	const publicBlocker = controls.some((element) => {
		const label = (element.getAttribute("aria-label") || element.innerText || "").replace(/\\s+/g, " ").trim().toLowerCase();
		return /^(accept all|accept selected|close settings|manage cookies|cookie settings|privacy settings)$/.test(label);
	});
	const consent = /(approve access|authorize|grant access|consent to|allow .* access)/.test(authCopy);
	const authPage = /(sign in|signin|log in|login|verify identity|two-factor|multi-factor|authentication)/.test(authCopy);
	let visibleText = (document.body.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 6000);
	for (const value of secretValues.sort((left, right) => right.length - left.length)) {
		if (value.length >= 8) visibleText = visibleText.split(value).join("[generated secret hidden]");
	}
	return {
		url: location.href,
		title: document.title,
		snapshot: lines.join("\\n") + "\\n\\nVisible text:\\n" + visibleText,
		handoffReady: !publicBlocker && (sensitive || consent || (username && authPage)),
	};
})()`;

async function waitForSettled(page: Page): Promise<void> {
	if (page.isClosed()) throw new Error("Qorpera Chrome tab is no longer available");
	await page.waitForLoadState("domcontentloaded", { timeout: 12_000 }).catch(() => {});
	await page.waitForTimeout(250);
}

function redactCopiedSnapshotValues(snapshot: string): string {
	const copiedValues = [...snapshot.matchAll(/copy to clipboard:\s*([^"\r\n]+)/gi)]
		.map((match) => match[1]?.trim())
		.filter((value): value is string => Boolean(value && value.length >= 8))
		.sort((left, right) => right.length - left.length);
	let sanitized = snapshot;
	for (const value of copiedValues) sanitized = sanitized.split(value).join("[copied value hidden]");
	return sanitized;
}

async function pageSnapshot(page: Page): Promise<ComputerSnapshot> {
	await waitForSettled(page);
	const value = (await page.evaluate(SNAPSHOT_SCRIPT)) as unknown;
	if (!value || typeof value !== "object") throw new Error("Qorpera Chrome returned an invalid page snapshot");
	const result = value as Record<string, unknown>;
	if (
		typeof result.url !== "string" ||
		typeof result.title !== "string" ||
		typeof result.snapshot !== "string" ||
		typeof result.handoffReady !== "boolean"
	) {
		throw new Error("Qorpera Chrome returned an invalid page snapshot");
	}
	const snapshot = {
		...(result as unknown as ComputerSnapshot),
		snapshot: redactCopiedSnapshotValues(result.snapshot),
	};
	return { ...snapshot, handoffReady: recognizedProtectedBoundary(snapshot) };
}

async function launchChrome(profilePath: string): Promise<BrowserContext> {
	return chromium.launchPersistentContext(profilePath, {
		channel: "chrome",
		chromiumSandbox: true,
		headless: false,
		viewport: null,
		args: [
			"--start-maximized",
			"--no-first-run",
			"--no-default-browser-check",
			"--disable-session-crashed-bubble",
			"--hide-crash-restore-bubble",
		],
	});
}

export function createComputerBroker(options: {
	sessionId: string;
	profilePath: string;
	launchChrome?: ChromeLauncher;
	allowedInitialUrl: (url: URL) => boolean;
	onHandoff?: (snapshot: ComputerSnapshot) => void | Promise<void>;
	storeSecret?: (name: string, value: string) => void | Promise<void>;
	observe?: (event: ComputerObservation) => void;
}): ComputerBroker {
	const intents = new Map<string, ComputerIntentState>();
	const seenRequestIds = new Set<string>();
	let context: BrowserContext | undefined;
	let page: Page | undefined;
	let starting: Promise<void> | undefined;
	let handedOff = false;
	let released = false;

	const endIntent = (intent: ComputerIntentState): void => {
		if (intent.status !== "active") return;
		intent.status = "ended";
		clearTimeout(intent.expiryTimer);
	};

	const ensureChrome = async (): Promise<void> => {
		if (context && page && !page.isClosed()) return;
		if (starting) return starting;
		starting = (async () => {
			const launched = await (options.launchChrome ?? launchChrome)(options.profilePath);
			context = launched;
			page = launched.pages().find((candidate) => !candidate.isClosed()) ?? (await launched.newPage());
			launched.on("page", (opened) => {
				page = opened;
			});
			launched.on("close", () => {
				if (context !== launched) return;
				context = undefined;
				page = undefined;
			});
		})().finally(() => {
			starting = undefined;
		});
		return starting;
	};

	const currentPage = async (): Promise<Page> => {
		await ensureChrome();
		if (!context) throw new Error("Qorpera could not start Google Chrome");
		if (!page || page.isClosed()) {
			page = context.pages().find((candidate) => !candidate.isClosed()) ?? (await context.newPage());
		}
		return page;
	};

	const openPrivateProviderUrl = async (rawUrl: string): Promise<void> => {
		const url = new URL(rawUrl);
		if (url.protocol !== "https:") throw new Error("private provider URL must use HTTPS");
		const computer = await currentPage();
		handedOff = true;
		await computer.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 30_000 });
		await computer.bringToFront();
		const snapshot = await pageSnapshot(computer);
		await options.onHandoff?.(snapshot);
	};

	const execute = async (frame: ComputerRequestFrame, send: (frame: object) => void): Promise<void> => {
		const deny = (reason: string): void => {
			options.observe?.({
				requestId: frame.requestId,
				action: frame.action,
				...(frame.url ? { url: frame.url } : {}),
				status: "denied",
				detail: reason,
			});
			send({ type: "qorpera_computer_response", requestId: frame.requestId, error: reason });
		};
		if (seenRequestIds.has(frame.requestId)) {
			deny("host computer action denied: replayed request id");
			return;
		}
		seenRequestIds.add(frame.requestId);
		const intent = intents.get(frame.intent.nonce);
		if (
			!intent ||
			intent.status !== "active" ||
			JSON.stringify(intent.capability) !== JSON.stringify(frame.intent) ||
			frame.intent.sessionId !== options.sessionId ||
			Date.parse(frame.intent.expiresAt) <= Date.now()
		) {
			deny("host computer action denied: no verified causal intent for this turn");
			return;
		}
		if (intent.actions >= MAX_ACTIONS_PER_TURN) {
			deny(`host computer action denied: turn action budget (${MAX_ACTIONS_PER_TURN}) exhausted`);
			return;
		}
		intent.actions++;
		options.observe?.({
			requestId: frame.requestId,
			action: frame.action,
			...(frame.url ? { url: frame.url } : {}),
			status: "started",
		});
		try {
			if (handedOff && frame.action !== "open" && frame.action !== "snapshot") {
				throw new Error(
					"private handoff is still active; wait for the founder, then use snapshot to check whether public setup can resume",
				);
			}
			let computer = await currentPage();
			if (frame.action === "open") {
				const url = new URL(frame.url!);
				if (url.protocol !== "https:" || !options.allowedInitialUrl(url)) {
					throw new Error("initial URL is not an owned connector registration origin");
				}
				handedOff = false;
				await computer.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 30_000 });
				await computer.bringToFront();
			} else if (frame.action === "click") {
				const before = new Set(context?.pages() ?? []);
				const target = computer.locator(`[data-qorpera-ref="${frame.ref}"]`).first();
				if ((await target.count()) === 0)
					throw new Error(`element ${frame.ref} is not present in the latest snapshot`);
				await target.click({ timeout: 12_000 });
				await computer.waitForTimeout(300);
				const opened = context?.pages().find((candidate) => !before.has(candidate) && !candidate.isClosed());
				if (opened) page = opened;
				computer = await currentPage();
			} else if (frame.action === "fill") {
				const before = await pageSnapshot(computer);
				if (before.handoffReady) {
					throw new Error("typing is disabled at sign-in, identity, MFA, and consent boundaries");
				}
				const target = computer.locator(`[data-qorpera-ref="${frame.ref}"]`).first();
				if ((await target.count()) === 0)
					throw new Error(`element ${frame.ref} is not present in the latest snapshot`);
				const sensitive = await target.evaluate((element) => {
					if (element.tagName.toLowerCase() !== "input") return false;
					const type = (element.getAttribute("type") || "text").toLowerCase();
					const autocomplete = (element.getAttribute("autocomplete") || "").toLowerCase();
					const identity = [
						element.getAttribute("name"),
						element.getAttribute("id"),
						element.getAttribute("placeholder"),
						element.getAttribute("aria-label"),
					]
						.filter(Boolean)
						.join(" ")
						.toLowerCase();
					const authContext = (
						element.closest("form,dialog,[role=dialog],[aria-modal=true]")?.textContent || ""
					).toLowerCase();
					return (
						type === "password" ||
						["current-password", "new-password", "one-time-code", "cc-number", "cc-csc"].includes(autocomplete) ||
						/(password|passcode|one.?time|otp|mfa|verification.?code|card.?number|security.?code|iban|bank.?account|routing.?number)/.test(
							identity,
						) ||
						((/(username|user.?id|account.?id)/.test(identity) || type === "email" || /email/.test(identity)) &&
							/(sign in|signin|log in|login|access your account|continue)/.test(authContext))
					);
				});
				if (sensitive) throw new Error("typing private authentication or financial data is disabled");
				await target.fill(frame.text!, { timeout: 12_000 });
			} else if (frame.action === "read_public_value") {
				const target = computer.locator(`[data-qorpera-ref="${frame.ref}"]`).first();
				if ((await target.count()) === 0)
					throw new Error(`element ${frame.ref} is not present in the latest snapshot`);
				const publicValue = await target.evaluate((element, marker) => {
					if (marker !== "qorpera-read-public-value") return undefined;
					if (element.getAttribute("data-qorpera-public-value") !== "true") return undefined;
					const label = (element.getAttribute("aria-label") || "").trim();
					const copied = label.match(/^copy to clipboard:\s*(.+)$/i)?.[1]?.trim() || "";
					const tag = element.tagName.toLowerCase();
					const value =
						tag === "input" || tag === "textarea"
							? String((element as unknown as { value?: unknown }).value || "").trim()
							: "";
					const candidate = copied || value;
					if (!candidate || candidate.length > 2_048 || /[\u0000-\u001f\u007f]/.test(candidate)) return undefined;
					return candidate;
				}, "qorpera-read-public-value");
				if (typeof publicValue !== "string" || !publicValue) {
					throw new Error("selected element is not a provider-generated public client identifier");
				}
				const snapshot = await pageSnapshot(computer);
				options.observe?.({
					requestId: frame.requestId,
					action: frame.action,
					url: snapshot.url,
					status: "completed",
				});
				send({
					type: "qorpera_computer_response",
					requestId: frame.requestId,
					...snapshot,
					publicValue,
				});
				return;
			} else if (frame.action === "store_secret") {
				if (!options.storeSecret) throw new Error("this computer has no company credential vault");
				const target = computer.locator(`[data-qorpera-ref="${frame.ref}"]`).first();
				if ((await target.count()) === 0)
					throw new Error(`element ${frame.ref} is not present in the latest snapshot`);
				const secret = await target.evaluate((element, marker) => {
					if (marker !== "qorpera-store-secret") return undefined;
					if (element.getAttribute("data-qorpera-generated-secret") !== "true") return undefined;
					const label = (element.getAttribute("aria-label") || "").trim();
					const copied = label.match(/^copy to clipboard:\s*(.+)$/i)?.[1]?.trim() || "";
					const tag = element.tagName.toLowerCase();
					const value =
						tag === "input" || tag === "textarea"
							? String((element as unknown as { value?: unknown }).value || "").trim()
							: "";
					const candidate = copied || value;
					if (!candidate || candidate.length > 16_384) return undefined;
					return candidate;
				}, "qorpera-store-secret");
				if (typeof secret !== "string" || !secret) {
					throw new Error("selected element is not a provider-generated secret field");
				}
				await options.storeSecret(frame.secretName!, secret);
			} else if (frame.action === "press") {
				await computer.keyboard.press(frame.key!);
			}
			const snapshot = await pageSnapshot(computer);
			let responseSnapshot = snapshot;
			if (handedOff && !snapshot.handoffReady) handedOff = false;
			if (frame.action === "snapshot" && handedOff) {
				if (snapshot.handoffReady) {
					responseSnapshot = {
						...snapshot,
						snapshot:
							"Private authentication is still in progress in Qorpera Chrome. Wait for the founder to finish before inspecting or acting on this page.",
					};
				} else {
					handedOff = false;
				}
			}
			if (frame.action === "handoff") {
				if (!snapshot.handoffReady) {
					throw new Error(
						"handoff rejected: an unobstructed sign-in, identity, MFA, or consent boundary is not ready",
					);
				}
				handedOff = true;
				await computer.bringToFront();
				try {
					await options.onHandoff?.(snapshot);
				} catch (error) {
					handedOff = false;
					throw error;
				}
			}
			let screenshotBase64: string | undefined;
			if (frame.action === "screenshot") {
				screenshotBase64 = (await computer.screenshot({ type: "png" })).toString("base64");
			}
			if (frame.action === "store_secret") {
				responseSnapshot = {
					...responseSnapshot,
					snapshot: `Stored secret://${frame.secretName} in the local company credential vault. The value was not exposed to the agent, chat, company files, or trail.\n\n${responseSnapshot.snapshot}`,
				};
			}
			options.observe?.({
				requestId: frame.requestId,
				action: frame.action,
				url: snapshot.url,
				status: frame.action === "handoff" ? "handoff" : "completed",
			});
			send({
				type: "qorpera_computer_response",
				requestId: frame.requestId,
				...responseSnapshot,
				...(screenshotBase64 ? { screenshotBase64 } : {}),
			});
		} catch (error) {
			const message = `host computer action failed: ${error instanceof Error ? error.message : String(error)}`;
			options.observe?.({
				requestId: frame.requestId,
				action: frame.action,
				...(frame.url ? { url: frame.url } : {}),
				status: "failed",
				detail: message,
			});
			send({ type: "qorpera_computer_response", requestId: frame.requestId, error: message });
		}
	};

	return {
		authorizeIntent: (capability) => {
			if (released || !validIntentShape(capability)) return false;
			const now = Date.now();
			const issuedAt = Date.parse(capability.issuedAt);
			const expiresAt = Date.parse(capability.expiresAt);
			if (
				capability.sessionId !== options.sessionId ||
				intents.has(capability.nonce) ||
				!Number.isFinite(issuedAt) ||
				!Number.isFinite(expiresAt) ||
				issuedAt > now + 5_000 ||
				expiresAt <= now ||
				expiresAt <= issuedAt ||
				expiresAt - issuedAt > MAX_INTENT_LIFETIME_MS
			) {
				return false;
			}
			const state: ComputerIntentState = {
				capability: JSON.parse(JSON.stringify(capability)) as KernelIntentCapability,
				actions: 0,
				status: "active",
				expiryTimer: setTimeout(() => endIntent(state), Math.max(1, expiresAt - now)),
			};
			state.expiryTimer.unref?.();
			intents.set(capability.nonce, state);
			return true;
		},
		handleFrame: (value, send) => {
			if (!value || typeof value !== "object") return false;
			if ((value as { type?: unknown }).type !== "qorpera_computer_request") return false;
			if (released) return true;
			const frame = parsedFrame(value);
			if (!frame) {
				const requestId = (value as { requestId?: unknown }).requestId;
				if (typeof requestId === "string") {
					send({
						type: "qorpera_computer_response",
						requestId,
						error: "host computer action denied: invalid frame",
					});
				}
				return true;
			}
			void execute(frame, send);
			return true;
		},
		handoffReady: () => handedOff,
		openPrivateProviderUrl,
		endTurn: () => {
			for (const intent of intents.values()) endIntent(intent);
			intents.clear();
		},
		release: () => {
			released = true;
			handedOff = false;
			for (const intent of intents.values()) endIntent(intent);
			intents.clear();
			if (context) void context.close().catch(() => {});
		},
	};
}
