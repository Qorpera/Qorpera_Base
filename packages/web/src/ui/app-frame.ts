import { PAGE_CONTENT, PAGE_ESCAPE, PAGE_FRAME_URL, PAGE_READY } from "./page-frame.ts";

/* An interface app's frame (deploy/first-node/RUNTIME-INTERFACE-APPS.md §5): the Company File's locked frame
 * (ui/page-frame.ts: sandboxed with no origin, no network, a fixed frame document), with one difference that makes it
 * safe to answer: the page is handed over once, with one end of a MessageChannel. The frame document keeps that port
 * from the page and reads through it with a frozen `qorpera` object (public/page-preview/index.html); the app answers
 * only on its own end, never on window messages, which every sandboxed frame on the page could send.
 * - One frame, one hand-over: a frame made here is answered the first time it says it is ready, and never again.
 * - A frame that says it is ready a second time, or loads a second time, has left the document it was handed (it
 *   reloaded or went somewhere): its port is closed and `left` is called, and the panel shows a new frame only when the
 *   member asks (Reload). A document the frame shows later has no port.
 * - Escape in the page reaches the frame as Escape (page-frame.ts' rule), so the panel closes as it does elsewhere. */

/** One call from the page, as the host takes it. */
export interface AppCall {
	readonly method: string;
	readonly params: Record<string, unknown>;
}

export type AppAnswer = { ok: true; value: unknown } | { ok: false; error: string };

/** What the host answers a page's calls with. */
export type AppCallHandler = (call: AppCall) => Promise<AppAnswer>;

/** A call's id the frame document makes: a counter. */
const MAX_ID = 2 ** 31;

export class AppFrame {
	readonly frame: HTMLIFrameElement;
	readonly #page: string;
	readonly #handle: AppCallHandler;
	readonly #left: () => void;
	readonly #lifetime = new AbortController();
	#port: MessagePort | undefined;
	#handed = false;
	#loads = 0;

	constructor(page: string, title: string, className: string, handle: AppCallHandler, left: () => void) {
		this.#page = page;
		this.#handle = handle;
		this.#left = left;
		const frame = document.createElement("iframe");
		frame.className = className;
		frame.setAttribute("sandbox", "allow-scripts");
		frame.setAttribute("referrerpolicy", "no-referrer");
		frame.setAttribute("src", PAGE_FRAME_URL);
		frame.title = title;
		this.frame = frame;
		const signal = this.#lifetime.signal;
		window.addEventListener("message", (event) => this.#message(event), { signal });
		// The frame document's load, then the page's own (written into it, it loads once more): any load after the page's
		// own means another document.
		frame.addEventListener(
			"load",
			() => {
				this.#loads++;
				if (this.#loads > 2) this.#leave();
			},
			{ signal },
		);
	}

	/** Tells the page that something it reads changed. */
	changed(): void {
		this.#port?.postMessage({ type: "qorpera-app-change" });
	}

	dispose(): void {
		this.#lifetime.abort();
		this.#port?.close();
		this.#port = undefined;
	}

	#leave(): void {
		if (this.#lifetime.signal.aborted) return;
		this.dispose();
		this.#left();
	}

	#message(event: MessageEvent): void {
		// The frame has no origin, so its window is the only thing that tells it apart.
		if (event.source === null || event.source !== this.frame.contentWindow) return;
		const data = event.data as { type?: unknown } | null;
		if (typeof data !== "object" || data === null) return;
		if (data.type === PAGE_ESCAPE) {
			this.frame.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
			return;
		}
		if (data.type !== PAGE_READY) return;
		if (this.#handed) {
			this.#leave();
			return;
		}
		this.#handed = true;
		const channel = new MessageChannel();
		this.#port = channel.port1;
		channel.port1.addEventListener("message", (call) => void this.#call(call.data), {
			signal: this.#lifetime.signal,
		});
		channel.port1.start();
		this.frame.contentWindow?.postMessage({ type: PAGE_CONTENT, html: this.#page }, "*", [channel.port2]);
	}

	async #call(data: unknown): Promise<void> {
		if (typeof data !== "object" || data === null || Array.isArray(data)) return;
		const { type, id, method, params } = data as Record<string, unknown>;
		if (type !== "qorpera-app-call" || typeof id !== "number" || !Number.isSafeInteger(id) || id < 1 || id > MAX_ID)
			return;
		const port = this.#port;
		if (!port) return;
		let answer: AppAnswer;
		if (typeof method !== "string" || typeof params !== "object" || params === null || Array.isArray(params))
			answer = { ok: false, error: "Not a call the app answers" };
		else
			try {
				answer = await this.#handle({ method, params: params as Record<string, unknown> });
			} catch {
				answer = { ok: false, error: "The app could not read that" };
			}
		// A frame that left while the call ran gets nothing.
		if (this.#port !== port) return;
		port.postMessage({ type: "qorpera-app-answer", id, ...answer });
	}
}
