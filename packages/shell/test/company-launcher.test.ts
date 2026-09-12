import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";

const rendererSource = readFileSync(join(import.meta.dirname, "../userland/renderer.js"), "utf-8");
const carouselSource = readFileSync(join(import.meta.dirname, "../userland/hub-carousel.js"), "utf-8");

function rendererFunction(name: string): string {
	const source = rendererSource.match(new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\n\\}`))?.[0];
	if (!source) throw new Error(`Renderer function missing: ${name}`);
	return source;
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

// Execute the shipping launcher functions, with just the DOM and IPC boundaries
// replaced. No model, network, authenticated account, or Company File is used.
class Element {
	readonly tag: string;
	textContent = "";
	innerHTML = "";
	className = "";
	hidden = false;
	disabled = false;
	value = "";
	children: Element[] = [];
	parent: Element | null = null;
	dataset: Record<string, string> = {};
	attributes = new Map<string, string>();
	onclick: (() => unknown) | null = null;
	onsubmit: ((event: unknown) => unknown) | null = null;
	classList = {
		add: (...names: string[]) => {
			this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(" ");
		},
		remove: (...names: string[]) => {
			this.className = this.className
				.split(/\s+/)
				.filter((name) => !names.includes(name))
				.join(" ");
		},
		contains: (name: string) => this.className.split(/\s+/).includes(name),
	};

	constructor(tag = "div") {
		this.tag = tag;
	}

	append(...children: Element[]) {
		for (const child of children) {
			child.parent = this;
			this.children.push(child);
		}
	}

	appendChild(child: Element) {
		this.append(child);
		return child;
	}

	replaceChildren(...children: Element[]) {
		for (const child of this.children) child.parent = null;
		this.children = [];
		this.append(...children);
	}

	remove() {
		if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this);
		this.parent = null;
	}

	setAttribute(key: string, value: string) {
		this.attributes.set(key, value);
	}

	querySelectorAll(selector: string): Element[] {
		return this.children.flatMap((child) => [
			...(selector === child.tag || (selector === "[data-account-provider]" && child.dataset.accountProvider)
				? [child]
				: []),
			...child.querySelectorAll(selector),
		]);
	}

	querySelector(selector: string): Element | null {
		return this.querySelectorAll(selector)[0] ?? null;
	}

	focus() {}
}

interface Company {
	name: string;
	root?: string;
	invitationPending?: boolean;
	invitationId?: string;
}

const company: Company = { name: "Company fixture", root: "/fixture/company" };
const gatewayError = new Error(
	"Error invoking remote method 'company:open': Error: <!DOCTYPE html><html><head><title>522: Connection timed out</title></head></html>",
);

function launcher() {
	const elements = new Map<string, Element>();
	const element = (id: string) => {
		let value = elements.get(id);
		if (!value) {
			value = new Element();
			elements.set(id, value);
		}
		return value;
	};
	element("accountEmailForm").appendChild(new Element("button"));
	const body = new Element("body");
	const documentElement = new Element("html");
	const bridge = {
		accountInfo: vi.fn<() => Promise<{ authenticated: boolean }>>().mockResolvedValue({ authenticated: true }),
		accountSignIn: vi.fn().mockResolvedValue({ ok: true, account: { authenticated: true } }),
		accountSignOut: vi.fn().mockResolvedValue({ ok: true }),
		appInfo: vi.fn<() => Promise<unknown>>().mockResolvedValue({ version: "fixture" }),
		listCompanies: vi.fn<() => Promise<Company[]>>().mockResolvedValue([company]),
		openCompany: vi.fn().mockResolvedValue(undefined),
		acceptCloudInvitation: vi.fn().mockResolvedValue({ ok: true }),
		updateState: vi.fn().mockResolvedValue(undefined),
	};
	const enterCompany = vi.fn(async () => {
		body.classList.remove("hub");
		body.classList.add("company-shell");
	});
	const context = {
		$: element,
		document: { body, documentElement, createElement: (tag: string) => new Element(tag) },
		window: { qorpera: bridge },
		setTimeout,
		clearTimeout,
		console: { warn: vi.fn() },
		hubLoadGeneration: 0,
		hubCompaniesRequest: null,
		workspaceBootGeneration: 0,
		renderUpdateButton: vi.fn(),
		applyFoundationUpdateState: vi.fn(),
		wireFriendsPanel: vi.fn(),
		makeCompanyIcon: () => new Element("span"),
		openCompanyModal: vi.fn(),
		PROFILE_ROLE_LABELS: {},
		enterCompany,
	};
	const functions = [
		"companyAccessError",
		"setAccountControlsDisabled",
		"completeAccountSignIn",
		"renderAccountWelcome",
		"presentCompanyHub",
		"renderHub",
		"renderHubCompanies",
		"signOut",
		"openCompany",
		"bootWorkspace",
		"bootSignedInWorkspace",
	]
		.map(rendererFunction)
		.join("\n");
	const startupStart = rendererSource.indexOf(
		"(async () => {",
		rendererSource.indexOf("async function bootSignedInWorkspace("),
	);
	const startupEnd = rendererSource.indexOf("\n})();", startupStart);
	expect(startupStart).toBeGreaterThan(-1);
	expect(startupEnd).toBeGreaterThan(startupStart);
	const startup = rendererSource.slice(startupStart, startupEnd + "\n})();".length);
	return {
		bridge,
		element,
		body,
		documentElement,
		enterCompany,
		run: (expression: string) => runInNewContext(`${functions}\n${expression}`, context) as Promise<void>,
		start: () => runInNewContext(`${functions}\n${startup}`, context) as Promise<void>,
	};
}

afterEach(() => vi.useRealTimers());

describe("company access", () => {
	it("opens the authenticated launcher straight into the hub", async () => {
		const ui = launcher();
		await ui.start();
		expect(ui.documentElement.dataset.qorperaReady).toBe("hub");
		expect(ui.element("hubCompanies").querySelector("strong")?.textContent).toBe(company.name);
		expect(ui.element("accountView").hidden).toBe(true);
	});

	it("completes a fresh Qorpera sign-in and lands in the hub", async () => {
		const ui = launcher();
		await ui.run('completeAccountSignIn({ provider: "github" })');
		expect(ui.bridge.accountSignIn).toHaveBeenCalledWith({ provider: "github" });
		expect(ui.documentElement.dataset.qorperaReady).toBe("hub");
	});

	it("still requires Qorpera authentication", async () => {
		const ui = launcher();
		ui.bridge.accountInfo.mockResolvedValue({ authenticated: false });
		await ui.start();
		expect(ui.documentElement.dataset.qorperaReady).toBe("account");
		expect(ui.bridge.appInfo).not.toHaveBeenCalled();
		expect(ui.bridge.listCompanies).not.toHaveBeenCalled();
	});

	it("restores an open company even when the updater check cannot complete", async () => {
		const ui = launcher();
		const activeCompany = { id: "fixture-company", root: company.root };
		ui.bridge.appInfo.mockResolvedValue({ version: "fixture", activeCompany });
		ui.bridge.updateState.mockReturnValue(new Promise(() => {}));
		await ui.start();
		expect(ui.enterCompany).toHaveBeenCalledWith(activeCompany);
		expect(ui.documentElement.dataset.qorperaReady).toBe("company");
	});
});

describe("recoverable cloud launcher failures", () => {
	it("draws before a stalled list resolves and does not issue duplicate requests", async () => {
		vi.useFakeTimers();
		const ui = launcher();
		const pending = deferred<Company[]>();
		ui.bridge.listCompanies.mockReturnValue(pending.promise);
		const loading = ui.run("renderHub()");
		expect(ui.element("hubCompanies").children).toHaveLength(1);
		expect(ui.element("hubCompanies").children[0].className).toContain("company-add-card");
		expect(ui.element("hubCompanies").attributes.get("aria-busy")).toBe("true");
		expect(ui.element("hubLoadStatus").textContent).toBe("Loading companies…");
		await vi.advanceTimersByTimeAsync(10_000);
		expect(ui.element("hubLoadStatus").textContent).toContain("taking longer than expected");
		await ui.run("renderHub()");
		expect(ui.bridge.listCompanies).toHaveBeenCalledTimes(1);
		pending.resolve([company]);
		await loading;
		expect(ui.element("hubCompanies").children).toHaveLength(2);
		expect(ui.element("hubLoadStatus").textContent).toBe("");
		expect(ui.element("hubCompanies").attributes.get("aria-busy")).toBe("false");
	});

	it("keeps company cards after a failed refresh and can retry without signing in again", async () => {
		const ui = launcher();
		await ui.start();
		const existingCard = ui.element("hubCompanies").children[0];
		ui.bridge.listCompanies.mockRejectedValueOnce(gatewayError);
		await ui.run("renderHub()");
		expect(ui.element("hubCompanies").children[0]).toBe(existingCard);
		expect(ui.element("hubError").textContent).toContain("cloud service could not be reached");
		expect(ui.element("hubError").textContent).not.toMatch(/html|remote method|522/i);
		expect(ui.element("hubRetry").hidden).toBe(false);
		ui.element("hubRetry").onclick?.();
		await vi.waitFor(() => expect(ui.element("hubRetry").hidden).toBe(true));
		await vi.waitFor(() => expect(ui.element("hubCompanies").children[0]).not.toBe(existingCard));
		expect(ui.element("hubError").textContent).toBe("");
		expect(ui.bridge.accountSignIn).not.toHaveBeenCalled();
	});

	it("recovers from a failed initial cloud list without an unhandled boot rejection", async () => {
		const ui = launcher();
		ui.bridge.listCompanies.mockRejectedValue(gatewayError);
		await expect(ui.start()).resolves.toBeUndefined();
		expect(ui.documentElement.dataset.qorperaReady).toBe("hub");
		expect(ui.element("hubRetry").hidden).toBe(false);
		expect(ui.element("hubCompanies").children).toHaveLength(1);
	});

	it("returns a failed startup company open to the usable launcher", async () => {
		const ui = launcher();
		ui.bridge.appInfo.mockResolvedValue({ version: "fixture", pendingCompany: company.root });
		ui.bridge.openCompany.mockRejectedValue(gatewayError);
		await ui.start();
		expect(ui.body.classList.contains("hub")).toBe(true);
		expect(ui.element("hubCompanies").children).toHaveLength(2);
		expect(ui.element("hubError").textContent).toContain("cloud service could not be reached");
	});

	it.each(["open", "invitation"])("clears the opening spinner after a rejected %s request", async (kind) => {
		const ui = launcher();
		ui.bridge.openCompany.mockRejectedValue(gatewayError);
		ui.bridge.acceptCloudInvitation.mockRejectedValue(gatewayError);
		ui.bridge.listCompanies.mockResolvedValue([
			{
				...company,
				invitationPending: kind === "invitation",
				invitationId: "fixture-invitation",
			},
		]);
		await ui.start();
		const card = ui.element("hubCompanies").children[0].children[0];
		await card.onclick?.();
		expect(ui.body.classList.contains("hub-opening")).toBe(false);
		expect(card.classList.contains("loading")).toBe(false);
		expect(ui.element("hubError").textContent).toContain("cloud service could not be reached");
	});

	it("shows a useful permission error instead of misclassifying it as a model or network failure", async () => {
		const ui = launcher();
		ui.bridge.openCompany.mockRejectedValue(
			new Error("Error invoking remote method 'company:open': Error: Membership required"),
		);
		await ui.run('openCompany("/fixture/company")');
		expect(ui.element("hubError").textContent).toBe("Membership required");
	});

	it.each(["resolve", "reject"])("ignores a company-list %s after sign-out", async (outcome) => {
		const ui = launcher();
		const pending = deferred<Company[]>();
		ui.bridge.listCompanies.mockReturnValue(pending.promise);
		const loading = ui.run("renderHub()");
		await ui.run("signOut()");
		if (outcome === "resolve") pending.resolve([company]);
		else pending.reject(gatewayError);
		await loading;
		expect(ui.documentElement.dataset.qorperaReady).toBe("account");
		expect(ui.body.classList.contains("hub")).toBe(false);
		expect(ui.element("hubCompanies").children).toHaveLength(0);
	});

	it("does not resurrect the launcher when app info resolves after sign-out", async () => {
		const ui = launcher();
		const pending = deferred<unknown>();
		ui.bridge.appInfo.mockReturnValue(pending.promise);
		const boot = ui.run("bootSignedInWorkspace()");
		await ui.run("signOut()");
		pending.resolve({ version: "fixture" });
		await boot;
		expect(ui.documentElement.dataset.qorperaReady).toBe("account");
		expect(ui.bridge.listCompanies).not.toHaveBeenCalled();
	});

	it("can retry a failed workspace bootstrap", async () => {
		const ui = launcher();
		ui.bridge.appInfo.mockRejectedValueOnce(new Error("bridge unavailable"));
		await ui.start();
		expect(ui.element("hubRetry").hidden).toBe(false);
		ui.element("hubRetry").onclick?.();
		await vi.waitFor(() => expect(ui.element("hubCompanies").children).toHaveLength(2));
	});
});

it("clears carousel controls when there are no company cards", () => {
	const nodes = new Map<string, Element>();
	for (const id of [
		"hubCompanies",
		"hubCarouselPrevious",
		"hubCarouselNext",
		"hubCarouselPagination",
		"hubCarouselStatus",
	]) {
		nodes.set(id, new Element());
	}
	const grid = nodes.get("hubCompanies");
	const frames: (() => void)[] = [];
	class Observer {
		observe() {}
	}
	runInNewContext(carouselSource, {
		document: {
			getElementById: (id: string) =>
				id === "hubCompanies" ? { ...grid, addEventListener: () => {} } : nodes.get(id),
		},
		window: {
			matchMedia: () => ({ matches: true }),
			requestAnimationFrame: (frame: () => void) => frames.push(frame),
		},
		MutationObserver: Observer,
		ResizeObserver: Observer,
	});
	frames[0]();
	expect(nodes.get("hubCarouselPrevious")?.disabled).toBe(true);
	expect(nodes.get("hubCarouselNext")?.disabled).toBe(true);
	expect(nodes.get("hubCarouselPagination")?.children).toHaveLength(0);
	expect(nodes.get("hubCarouselStatus")?.textContent).toBe("");
});
