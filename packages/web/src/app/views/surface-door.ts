import {
	type CompiledIdentityTokens,
	type PointToChangeTarget,
	parsePointToChangeTarget,
	SURFACE_INSPECTOR_MODE_MESSAGE,
	SURFACE_INSPECTOR_PICK_MESSAGE,
	type SurfacePreviewFrameState,
} from "@qorpera/contracts";
import { h } from "../../ui/dom.ts";
import { t } from "../../ui/preferences.ts";
import { SITE_DOOR_PASS, SITE_DOOR_READY, SITE_DOOR_SHOWN, SITE_DOOR_URL } from "./site-view.ts";

export const IDENTITY_TOKENS_CSS_MESSAGE = "qorpera:identity-tokens-css";

export function applyIdentityTokensToFrame(
	iframe: HTMLIFrameElement,
	tokens: CompiledIdentityTokens | null,
	injectStyle = true,
): void {
	const css = tokens?.css ?? "";
	const vars = tokens?.vars ?? {};
	if (injectStyle) {
		try {
			const doc = iframe.contentDocument;
			if (doc?.head) {
				let style = doc.head.querySelector<HTMLStyleElement>("style[data-qorpera-identity-tokens]");
				if (css) {
					if (!style) {
						style = doc.createElement("style");
						style.setAttribute("data-qorpera-identity-tokens", "");
						doc.head.append(style);
					}
					if (style.textContent !== css) style.textContent = css;
				} else if (style) {
					style.remove();
				}
			}
		} catch {
			/* WHY: Cross-origin preview frames block contentDocument access and receive tokens via postMessage below. */
		}
	}
	try {
		iframe.contentWindow?.postMessage({ type: IDENTITY_TOKENS_CSS_MESSAGE, css, vars }, "*");
	} catch {
		/* WHY: Detached or initializing frames ignore postMessage until ready. */
	}
}

// WHY: Matches SiteView's sandbox so previews run scripts and forms on their own origin without touching this app's page.
const SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox";
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 15_000;

interface DoorSlot {
	readonly key: string;
	readonly previewId: string;
	readonly iframe: HTMLIFrameElement;
	readonly action: string;
	readonly pass: string;
	readonly path: string;
	sent: boolean;
	timeout: ReturnType<typeof setTimeout> | undefined;
}

export interface SurfaceDoorOptions {
	readonly onPick?: (target: PointToChangeTarget) => void;
	readonly onShownChange?: () => void;
	readonly onRetry?: () => void;
	readonly handshakeTimeoutMs?: number;
	readonly isPassUsable?: (previewId: string, pass: string) => boolean;
	readonly onPassSent?: (previewId: string, pass: string) => void;
	readonly onNeedFreshPass?: (previewId: string, stalePass?: string) => Promise<boolean> | undefined;
}

export type BuildFailureCode =
	| "PREVIEW_BUILD_FAILED"
	| "PREVIEW_BUILD_NO_HOURS"
	| "PREVIEW_BUILD_NO_MACHINE"
	| "PREVIEW_BUILD_TOO_LARGE";

const BUILD_FAILURE_CODES: ReadonlySet<string> = new Set<BuildFailureCode>([
	"PREVIEW_BUILD_FAILED",
	"PREVIEW_BUILD_NO_HOURS",
	"PREVIEW_BUILD_NO_MACHINE",
	"PREVIEW_BUILD_TOO_LARGE",
]);

export function buildFailureCode(detail: string | null | undefined): BuildFailureCode | null {
	const code = detail?.split("\n", 1)[0]?.trim() ?? "";
	return BUILD_FAILURE_CODES.has(code) ? (code as BuildFailureCode) : null;
}

function previewFailureText(detail: string | null | undefined): string {
	switch (buildFailureCode(detail)) {
		case "PREVIEW_BUILD_NO_HOURS":
			return t("The company is out of computer hours, so the preview could not be built.");
		case "PREVIEW_BUILD_NO_MACHINE":
			return t("No machine was free to build the preview. Try again in a moment.");
		case "PREVIEW_BUILD_TOO_LARGE":
			return t("The built preview does not fit within the limits of a site.");
		default:
			return t("The preview could not be built.");
	}
}

export function publishFailureText(detail: string | null | undefined): string | null {
	switch (buildFailureCode(detail)) {
		case "PREVIEW_BUILD_FAILED":
			return t("The site could not be built, so nothing was published.");
		case "PREVIEW_BUILD_NO_HOURS":
			return t("The company is out of computer hours, so nothing was published.");
		case "PREVIEW_BUILD_NO_MACHINE":
			return t("No machine was free to build the site. Try publishing again in a moment.");
		case "PREVIEW_BUILD_TOO_LARGE":
			return t("The built site does not fit within the limits of a site, so nothing was published.");
		default:
			return null;
	}
}

export function previewStatusText(frame: SurfacePreviewFrameState): string {
	switch (frame.status) {
		case "composing":
			return t("Composing preview…");
		case "reconciling":
		case "conflicted":
			return t("Updating preview…");
		case "building":
			return t("Building preview…");
		case "failed":
			return previewFailureText(frame.errorDetail);
		default:
			return "";
	}
}

export class SurfaceDoorStage {
	readonly el = h("div", { class: "surface-door-stage" });
	readonly #lifetime = new AbortController();
	readonly #waitingState = h("span", { class: "surface-state is-running" });
	readonly #waitingFigure = h("div", { class: "surface-door-figure", hidden: true });
	#figureKey = "";
	readonly #waitingText = h("p");
	readonly #retryBtn = h(
		"button",
		{
			type: "button",
			class: "btn btn-small surface-door-retry",
			"data-act": "retry-preview",
			hidden: true,
		},
		t("Retry preview"),
	);
	readonly #waiting = h(
		"div",
		{ class: "surface-frame is-waiting", hidden: true },
		this.#waitingFigure,
		this.#waitingState,
		this.#waitingText,
		this.#retryBtn,
	);
	readonly #pillText = h("span");
	readonly #pillDot = h("span", { class: "surface-state is-running" });
	readonly #pill = h(
		"div",
		{ class: "surface-preview-pill", hidden: true, role: "status" },
		this.#pillDot,
		this.#pillText,
	);
	readonly #options: SurfaceDoorOptions;
	#active: DoorSlot | undefined;
	#staging: DoorSlot | undefined;
	#retriedPreviewId: string | undefined;
	#failedPreviewKey: string | undefined;
	#requestedPassKey: string | undefined;
	#inspectorActive = false;
	#identityTokens: CompiledIdentityTokens | null = null;
	#identityTokensCss = "";
	#mark: { readonly words: string; readonly kind: "running" | "failed" } | null = null;

	constructor(signal: AbortSignal, options: SurfaceDoorOptions = {}) {
		this.#options = options;
		signal.addEventListener("abort", () => this.dispose(), { once: true });
		this.#retryBtn.addEventListener(
			"click",
			() => {
				this.resetRetryState();
				this.#options.onRetry?.();
			},
			{ signal: this.#lifetime.signal },
		);
		this.el.append(this.#waiting, this.#pill);
		window.addEventListener("message", (event) => this.#onMessage(event), { signal: this.#lifetime.signal });
	}

	get hasShown(): boolean {
		return Boolean(this.#active);
	}

	sync(frame: SurfacePreviewFrameState, title: string): void {
		if (this.#lifetime.signal.aborted) return;
		const kept = frame.status === "failed" ? frame.kept : null;
		if (!kept) {
			this.#mark = null;
			this.#show(frame, title);
			return;
		}
		this.#mark = frame.fixing
			? { words: t("Being fixed"), kind: "running" }
			: { words: previewFailureText(frame.errorDetail), kind: "failed" };
		this.#show(
			{
				...frame,
				status: "ready",
				previewId: kept.previewId,
				doorActionUrl: kept.doorActionUrl,
				memberPass: kept.memberPass,
				errorDetail: null,
				kept: null,
				fixing: false,
			},
			title,
		);
	}

	#show(frame: SurfacePreviewFrameState, title: string): void {
		const previewId = frame.previewId ?? "";
		if (frame.status === "ready" && (previewId || (frame.doorActionUrl && frame.memberPass))) {
			const path = frame.activeRoute.startsWith("/") ? frame.activeRoute : "/";
			const targetKey = `${previewId}\0${path}`;
			if (
				this.#active &&
				this.#active.previewId === previewId &&
				this.#active.path === path &&
				(!frame.doorActionUrl || this.#active.action === frame.doorActionUrl)
			) {
				this.#active.iframe.title = title;
				this.#dropStaging();
				this.#retriedPreviewId = undefined;
				this.#failedPreviewKey = undefined;
				this.#requestedPassKey = undefined;
				this.#waiting.hidden = true;
				this.#restPill();
				return;
			}
			const staging = this.#staging;
			if (
				staging &&
				staging.previewId === previewId &&
				staging.path === path &&
				(!frame.doorActionUrl || staging.action === frame.doorActionUrl)
			) {
				const freshPassForUnsent =
					!staging.sent &&
					Boolean(frame.doorActionUrl) &&
					frame.memberPass !== null &&
					frame.memberPass !== "" &&
					frame.memberPass !== staging.pass &&
					(!previewId || !this.#options.isPassUsable || this.#options.isPassUsable(previewId, frame.memberPass));
				if (!freshPassForUnsent) {
					staging.iframe.title = title;
					this.#restPill();
					if (!this.#active) this.#showWaiting("running", t("Opening preview…"));
					return;
				}
			}
			if (!frame.doorActionUrl || !frame.memberPass) {
				this.#dropStaging();
				if (this.#failedPreviewKey === targetKey) {
					this.#restPill();
					if (!this.#active) this.#showWaiting("failed", t("The preview could not be opened."));
					return;
				}
				const alreadyRequested =
					this.#requestedPassKey === targetKey ||
					Boolean(previewId && this.#requestedPassKey?.startsWith(`${previewId}\0`));
				if (previewId && this.#options.onNeedFreshPass && !alreadyRequested) {
					this.#requestFreshPass(previewId, targetKey, targetKey);
				}
				this.#restPill();
				if (!this.#active) {
					this.#showWaiting(
						"running",
						this.#retriedPreviewId && this.#retriedPreviewId === previewId
							? t("Reconnecting preview…")
							: t("Opening preview…"),
					);
				}
				return;
			}
			if (previewId && this.#options.isPassUsable && !this.#options.isPassUsable(previewId, frame.memberPass)) {
				this.#dropStaging();
				if (this.#failedPreviewKey === targetKey) {
					this.#restPill();
					if (!this.#active) this.#showWaiting("failed", t("The preview could not be opened."));
					return;
				}
				const staleKey = `${previewId}\0${frame.memberPass}`;
				if (this.#options.onNeedFreshPass && this.#requestedPassKey !== staleKey) {
					this.#requestFreshPass(previewId, staleKey, targetKey, frame.memberPass);
				}
				this.#restPill();
				if (!this.#active) this.#showWaiting("running", t("Opening preview…"));
				return;
			}
			this.#failedPreviewKey = undefined;
			this.#requestedPassKey = undefined;
			if (this.#retriedPreviewId && this.#retriedPreviewId !== previewId) this.#retriedPreviewId = undefined;
			this.#dropStaging();
			const key = `${previewId}\0${frame.doorActionUrl}\0${frame.memberPass}\0${path}`;
			const iframe = h("iframe", {
				class: "surface-frame is-staging",
				sandbox: SANDBOX,
				referrerpolicy: "no-referrer",
				title,
			});
			const slot: DoorSlot = {
				key,
				previewId,
				iframe,
				action: frame.doorActionUrl,
				pass: frame.memberPass,
				path,
				sent: false,
				timeout: undefined,
			};
			const timeoutMs = this.#options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
			if (timeoutMs > 0) {
				slot.timeout = setTimeout(() => {
					slot.timeout = undefined;
					if (this.#lifetime.signal.aborted || this.#staging !== slot) return;
					this.#dropStaging();
					if (previewId && this.#options.onNeedFreshPass && this.#retriedPreviewId !== previewId) {
						this.#retriedPreviewId = previewId;
						this.#restPill();
						if (!this.#active) this.#showWaiting("running", t("Reconnecting preview…"));
						this.#requestFreshPass(previewId, `${previewId}\0${slot.pass}`, targetKey, slot.pass);
						return;
					}
					this.#failedPreviewKey = targetKey;
					this.#restPill();
					this.#dropActive();
					this.#showWaiting("failed", t("The preview could not be opened."));
				}, timeoutMs);
			}
			this.#staging = slot;
			this.el.append(iframe);
			iframe.src = SITE_DOOR_URL;
			this.#restPill();
			if (this.#active) {
				this.#waiting.hidden = true;
			} else {
				this.#showWaiting("running", t("Opening preview…"));
			}
			return;
		}
		this.#retriedPreviewId = undefined;
		this.#failedPreviewKey = undefined;
		this.#requestedPassKey = undefined;
		this.#dropStaging();
		if (
			frame.status === "composing" ||
			frame.status === "reconciling" ||
			frame.status === "building" ||
			frame.status === "conflicted"
		) {
			const words = previewStatusText(frame);
			if (this.#active) {
				this.#waiting.hidden = true;
				this.#showPill(words, "running");
			} else {
				this.#restPill();
				this.#showWaiting("running", words);
			}
			return;
		}
		this.#restPill();
		this.#dropActive();
		this.#showWaiting(
			frame.status === "failed" ? "failed" : "running",
			previewStatusText(frame) || t("Preview appears here when a change is ready."),
		);
	}

	setFigure(key: string, make: (() => HTMLElement) | null): void {
		if (key === this.#figureKey) return;
		this.#figureKey = key;
		const figure = make?.();
		if (figure) this.#waitingFigure.replaceChildren(h("span", { class: "surface-door-figure-shadow" }), figure);
		else this.#waitingFigure.replaceChildren();
		this.#syncWaitingFigure();
	}

	setInspectorMode(active: boolean): void {
		this.#inspectorActive = active;
		this.#postInspectorMode(active);
	}

	setIdentityTokens(tokens: CompiledIdentityTokens | null): void {
		const nextCss = tokens?.css ?? "";
		if (nextCss === this.#identityTokensCss && Boolean(tokens) === Boolean(this.#identityTokens)) return;
		this.#identityTokens = tokens;
		this.#identityTokensCss = nextCss;
		this.#postIdentityTokens();
	}

	resetRetryState(): void {
		this.#retriedPreviewId = undefined;
		this.#failedPreviewKey = undefined;
		this.#requestedPassKey = undefined;
	}

	clear(): void {
		this.#mark = null;
		if (this.#inspectorActive) {
			this.#postInspectorMode(false);
			this.#inspectorActive = false;
		}
		this.resetRetryState();
		this.#dropStaging();
		this.#dropActive();
		this.#retryBtn.hidden = true;
		this.#waiting.hidden = true;
		this.#restPill();
	}

	dispose(): void {
		this.clear();
		this.#lifetime.abort();
		this.el.remove();
	}

	#requestFreshPass(previewId: string, requestKey: string, failKey: string, stalePass?: string): void {
		this.#requestedPassKey = requestKey;
		const onFailure = () => {
			if (this.#lifetime.signal.aborted || this.#requestedPassKey !== requestKey || this.#staging) return;
			this.#requestedPassKey = undefined;
			this.#retriedPreviewId = undefined;
			this.#failedPreviewKey = failKey;
			this.#restPill();
			this.#dropActive();
			this.#showWaiting("failed", t("The preview could not be opened."));
		};
		let result: Promise<boolean> | undefined;
		try {
			result = this.#options.onNeedFreshPass?.(previewId, stalePass);
		} catch {
			onFailure();
			return;
		}
		if (result && typeof result.then === "function") {
			void result.then((minted) => {
				if (minted === false) onFailure();
			}, onFailure);
		}
	}

	#showPill(words: string, kind: "running" | "failed"): void {
		this.#pillDot.className = `surface-state is-${kind}`;
		this.#pillText.textContent = words;
		this.#pill.hidden = false;
	}

	#restPill(): void {
		if (this.#mark && this.#active) this.#showPill(this.#mark.words, this.#mark.kind);
		else this.#pill.hidden = true;
	}

	#showWaiting(kind: "running" | "conflicted" | "failed", words: string): void {
		this.#waitingState.className = `surface-state is-${kind}`;
		this.#waitingText.textContent = words;
		this.#retryBtn.hidden = kind !== "failed" || !this.#options.onRetry;
		this.#waiting.hidden = false;
		this.#syncWaitingFigure();
	}

	#syncWaitingFigure(): void {
		const show = this.#waitingState.classList.contains("is-running") && this.#waitingFigure.childElementCount > 0;
		this.#waitingFigure.hidden = !show;
		this.#waiting.classList.toggle("has-figure", show);
		this.#waitingState.hidden = show;
	}

	#dropStaging(): void {
		if (!this.#staging) return;
		if (this.#staging.timeout) {
			clearTimeout(this.#staging.timeout);
			this.#staging.timeout = undefined;
		}
		this.#staging.iframe.remove();
		this.#staging = undefined;
	}

	#dropActive(): void {
		if (!this.#active) return;
		this.#active.iframe.remove();
		this.#active = undefined;
		this.#pill.hidden = true;
		this.#options.onShownChange?.();
	}

	#postInspectorMode(active: boolean): void {
		const target = this.#active?.iframe.contentWindow;
		if (!target) return;
		target.postMessage({ type: SURFACE_INSPECTOR_MODE_MESSAGE, active }, location.origin);
	}

	#postIdentityTokens(): void {
		if (!this.#active) return;
		applyIdentityTokensToFrame(this.#active.iframe, this.#identityTokens, false);
	}

	#onMessage(event: MessageEvent): void {
		if (event.origin !== location.origin) return;
		const data = event.data as { type?: unknown; target?: unknown } | null;
		if (!data || typeof data !== "object") return;
		const staging = this.#staging;
		if (staging && event.source === staging.iframe.contentWindow) {
			if (data.type === SITE_DOOR_READY && !staging.sent) {
				staging.sent = true;
				if (staging.previewId) this.#options.onPassSent?.(staging.previewId, staging.pass);
				staging.iframe.contentWindow?.postMessage(
					{
						type: SITE_DOOR_PASS,
						action: staging.action,
						pass: staging.pass,
						title: staging.iframe.title,
						path: staging.path,
					},
					location.origin,
				);
				return;
			}
			if (data.type === SITE_DOOR_SHOWN && staging.sent) {
				if (staging.timeout) {
					clearTimeout(staging.timeout);
					staging.timeout = undefined;
				}
				const previous = this.#active;
				this.#active = staging;
				this.#staging = undefined;
				this.#retriedPreviewId = undefined;
				this.#failedPreviewKey = undefined;
				this.#requestedPassKey = undefined;
				staging.iframe.classList.remove("is-staging");
				staging.iframe.classList.add("is-shown");
				previous?.iframe.remove();
				this.#waiting.hidden = true;
				this.#restPill();
				this.#options.onShownChange?.();
				if (this.#inspectorActive) this.#postInspectorMode(true);
				if (this.#identityTokens) this.#postIdentityTokens();
				return;
			}
		}
		const active = this.#active;
		if (!active || event.source !== active.iframe.contentWindow) return;
		if (data.type === SITE_DOOR_SHOWN) {
			if (this.#inspectorActive) this.#postInspectorMode(true);
			if (this.#identityTokens) this.#postIdentityTokens();
			return;
		}
		if (data.type === SURFACE_INSPECTOR_PICK_MESSAGE && this.#options.onPick) {
			try {
				this.#options.onPick(parsePointToChangeTarget(data.target));
			} catch {
				/* WHY: Ignore malformed pick payloads from preview frames. */
			}
		}
	}
}
