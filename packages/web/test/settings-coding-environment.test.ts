// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { type CodingEnvironmentAccess, CodingEnvironmentView } from "../src/app/views/settings-coding-environment.ts";
import { CloudRpcError } from "../src/cloud/client.ts";
import type {
	CodingEnvironmentCapture,
	CodingEnvironmentGrant,
	CodingEnvironmentOwner,
	CodingEnvironmentVariable,
	WebCodingEnvironment,
} from "../src/cloud/coding-environment.ts";
import { id, settle, timestamp } from "./fixtures.ts";

const webGrant: CodingEnvironmentGrant = {
	grantId: id(41),
	repository: "acme/web",
	issuedByUserId: id(1),
	createdAt: timestamp,
};
// Given to acme/web, where it wins over a member's NPM_TOKEN.
const companyToken: CodingEnvironmentVariable = {
	secretId: id(30),
	name: "NPM_TOKEN",
	ownerKind: "company",
	purpose: "Installs private packages",
	version: 1,
	grants: [webGrant],
	createdAt: timestamp,
	updatedAt: timestamp,
};
const companyLone: CodingEnvironmentVariable = {
	secretId: id(31),
	name: "SENTRY_TOKEN",
	ownerKind: "company",
	purpose: "Uploads source maps",
	version: 1,
	grants: [],
	createdAt: timestamp,
	updatedAt: timestamp,
};
const memberToken: CodingEnvironmentVariable = {
	secretId: id(32),
	name: "NPM_TOKEN",
	ownerKind: "member",
	purpose: "My own registry token",
	version: 1,
	grants: [],
	createdAt: timestamp,
	updatedAt: timestamp,
};
const memberOwn: CodingEnvironmentVariable = {
	secretId: id(33),
	name: "GH_PACKAGES",
	ownerKind: "member",
	purpose: "Reads GitHub packages",
	version: 1,
	grants: [],
	createdAt: timestamp,
	updatedAt: timestamp,
};
const everything = [companyToken, companyLone, memberToken, memberOwn];

const manager: CodingEnvironmentAccess = { canManage: () => true };

let view: CodingEnvironmentView | undefined;
afterEach(() => {
	view?.dispose();
	view = undefined;
	document.body.replaceChildren();
	vi.restoreAllMocks();
});

function setup(
	owner: CodingEnvironmentOwner,
	variables: CodingEnvironmentVariable[] = everything,
	access: CodingEnvironmentAccess = manager,
	configure?: (client: WebCodingEnvironment) => void,
	onChange?: () => void,
) {
	const state = { variables: structuredClone(variables), next: 80 };
	const client: WebCodingEnvironment = {
		list: vi.fn(async () => structuredClone(state.variables)),
		capture: vi.fn(async (input: CodingEnvironmentCapture) => {
			const known = state.variables.find((variable) => variable.secretId === input.existingSecretId);
			if (known) known.version += 1;
			else
				state.variables.push({
					secretId: id(state.next++),
					name: input.name,
					ownerKind: input.ownerKind,
					purpose: input.purpose,
					version: 1,
					grants: [],
					createdAt: timestamp,
					updatedAt: timestamp,
				});
		}),
		grant: vi.fn(async (secretId: string, repository: string) => {
			const grant: CodingEnvironmentGrant = { ...webGrant, grantId: id(90), repository };
			state.variables.find((variable) => variable.secretId === secretId)?.grants.push(grant);
			return structuredClone(grant);
		}),
		revokeGrant: vi.fn(async (grantId: string) => {
			for (const variable of state.variables)
				variable.grants = variable.grants.filter((grant) => grant.grantId !== grantId);
		}),
		remove: vi.fn(async (secretId: string) => {
			state.variables = state.variables.filter((variable) => variable.secretId !== secretId);
		}),
	};
	configure?.(client);
	view = new CodingEnvironmentView(client, new AbortController().signal, { owner, access, onChange });
	document.body.append(view.el);
	return { client, state };
}

const cardOf = (secretId: string) => view?.el.querySelector<HTMLElement>(`[data-variable="${secretId}"]`) ?? null;
const cards = () => [...view!.el.querySelectorAll<HTMLElement>("[data-variable]")].map((card) => card.dataset.variable);
const reach = (secretId: string) => cardOf(secretId)?.querySelector(".hook-state")?.textContent;
const buttons = (root: Element) => [...root.querySelectorAll<HTMLButtonElement>("button")];
const labels = (root: Element) => buttons(root).map((item) => item.textContent);
const press = (root: Element, label: string) =>
	buttons(root)
		.find((item) => item.textContent === label)!
		.click();
const dialog = () => [...document.querySelectorAll<HTMLElement>('[role="alertdialog"]')].at(-1)!;
const outcome = () => view!.el.querySelector(".service-outcome")?.textContent;
const field = (label: string) =>
	view!.el.querySelector<HTMLInputElement | HTMLTextAreaElement>(
		`input[aria-label="${label}"], textarea[aria-label="${label}"]`,
	)!;

/** Types text into a field. */
function fill(label: string, text: string): void {
	field(label).value = text;
	field(label).dispatchEvent(new Event("input"));
}

/** Pastes text into a field as a browser does: the paste event carries the text as it came, and the field then holds
 * it with every line break read back as LF. */
function paste(label: string, text: string): void {
	const event = new Event("paste", { bubbles: true, cancelable: true });
	const clipboardData = { getData: (type: string) => (type === "text/plain" ? text : "") };
	Object.defineProperty(event, "clipboardData", { value: clipboardData });
	field(label).dispatchEvent(event);
	fill(label, text);
}

/** No field in the page holds the value any more. */
function forgotten(value: string): void {
	for (const input of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea"))
		expect(input.value).not.toBe(value);
	expect(document.body.innerHTML).not.toContain(value);
}

/** Opens the add form if needed, fills it in and presses Add (Enter in the value field is a line break). */
function add(name: string, purpose: string, value: string): void {
	if (!view!.el.querySelector("form.hook-form")) press(view!.el, "Add a variable");
	fill("Variable name", name);
	fill("What it is for", purpose);
	fill("Value", value);
	press(view!.el.querySelector("form.hook-form")!, "Add");
}

describe("environment variables for coding", () => {
	it("shows a company's variables and which repositories' coding sessions get them", async () => {
		setup("company");
		await settle();
		expect(view!.el.querySelector("h2")?.textContent).toBe("Environment variables for coding");
		expect(view!.el.textContent).toContain(
			"A coding session gets one of these only in a repository it's given to. They stay when someone leaves.",
		);
		expect(cards()).toEqual([companyToken.secretId, companyLone.secretId]);
		const token = cardOf(companyToken.secretId)!;
		expect(token.querySelector("strong")?.textContent).toBe("NPM_TOKEN");
		expect(token.querySelector("svg")).not.toBeNull();
		expect(token.textContent).toContain("Installs private packages");
		expect(reach(companyToken.secretId)).toBe("Coding sessions in acme/web get it.");
		expect(reach(companyLone.secretId)).toBe("No coding session gets it yet.");
		expect(labels(token)).toEqual(["Remove", "Remove", "Replace value", "Give to a repository"]);
		expect(token.querySelector(`[data-grant="${webGrant.grantId}"]`)?.textContent).toContain("acme/web");
	});

	it("shows a member's own, and where the company's of the same name is used instead", async () => {
		setup("member");
		await settle();
		expect(view!.el.textContent).toContain(
			"Your coding sessions get these in every repository. They leave with you.",
		);
		expect(cards()).toEqual([memberToken.secretId, memberOwn.secretId]);
		expect(reach(memberOwn.secretId)).toBe("Your coding sessions get it.");
		expect(reach(memberToken.secretId)).toBe(
			"Your coding sessions get it. In acme/web, the company's NPM_TOKEN is used instead.",
		);
		// A member's own is never given to a repository.
		expect(labels(cardOf(memberOwn.secretId)!)).toEqual(["Remove", "Replace value"]);
	});

	it("adds a member's variable, upper-casing its name, and forgets the value", async () => {
		const { client } = setup("member", []);
		await settle();
		expect(view!.el.textContent).toContain("No variables yet.");
		add(" npm_token ", " Installs private packages ", "fake-value-1");
		expect(labels(view!.el)).toContain("Adding…");
		forgotten("fake-value-1");
		await settle();
		expect(client.capture).toHaveBeenCalledWith(
			{
				ownerKind: "member",
				name: "NPM_TOKEN",
				purpose: "Installs private packages",
				value: "fake-value-1",
				existingSecretId: undefined,
			},
			expect.any(AbortSignal),
		);
		expect(cards()).toEqual([id(80)]);
		expect(cardOf(id(80))?.textContent).toContain(
			"NPM_TOKEN is saved. Your coding sessions get it from their next start.",
		);
		expect(view!.el.querySelector("form.hook-form")).toBeNull();
		expect((document.activeElement as HTMLElement).dataset.focusKey).toBe("coding-add:member");
		forgotten("fake-value-1");
	});

	it("says a company variable reaches no one until it is given to a repository", async () => {
		setup("company", []);
		await settle();
		add("SENTRY_TOKEN", "Uploads source maps", "fake-value-1");
		await settle();
		expect(cardOf(id(80))?.textContent).toContain(
			"SENTRY_TOKEN is saved. Give it to a repository so coding sessions there get it.",
		);
		expect(reach(id(80))).toBe("No coding session gets it yet.");
	});

	it("refuses a bad name, a missing purpose, a short value and a NUL before any call", async () => {
		const { client } = setup("member", []);
		await settle();
		add("npm-token", "Packages", "fake-value-1");
		expect(outcome()).toBe("A variable name is capital letters, digits and underscores, and starts with a letter.");
		expect(document.activeElement).toBe(field("Variable name"));
		forgotten("fake-value-1");

		add("NPM_TOKEN", " ", "fake-value-1");
		expect(outcome()).toBe("Say what it is for, in one line.");

		add("NPM_TOKEN", "Packages", "fake-12");
		expect(outcome()).toBe("The value must be at least 8 characters.");
		expect(document.activeElement).toBe(field("Value"));
		forgotten("fake-12");

		add("NPM_TOKEN", "Packages", "fake-value\0");
		expect(outcome()).toBe("The value can't contain a null character.");
		expect(client.capture).not.toHaveBeenCalled();
		// The name and purpose stay for the next try.
		expect(field("Variable name").value).toBe("NPM_TOKEN");
		expect(field("What it is for").value).toBe("Packages");
	});

	it("replaces the value when the name is already this owner's", async () => {
		const { client } = setup("member");
		await settle();
		add("GH_PACKAGES", "Reads GitHub packages", "fake-value-2");
		await settle();
		expect(client.capture).toHaveBeenCalledWith(
			expect.objectContaining({ ownerKind: "member", name: "GH_PACKAGES", existingSecretId: memberOwn.secretId }),
			expect.any(AbortSignal),
		);
		expect(cardOf(memberOwn.secretId)?.textContent).toContain(
			"The value of GH_PACKAGES is replaced. Your coding sessions get the new one from their next start.",
		);
	});

	it("says a name kept by the coding machine or a sign-in is taken, and why a member may not add", async () => {
		const { client } = setup("company", []);
		await settle();
		vi.mocked(client.capture).mockRejectedValueOnce(
			new CloudRpcError("qorpera_begin_cloud_secret_capture", {
				message: "That name is not available for an environment variable",
				code: "22023",
			}),
		);
		add("OPENAI_API_KEY", "Model access", "fake-value-1");
		await settle();
		expect(outcome()).toBe("That name is taken by the coding machine or an AI provider's sign-in. Choose another.");
		expect(field("Variable name").value).toBe("OPENAI_API_KEY");
		forgotten("fake-value-1");

		vi.mocked(client.capture).mockRejectedValueOnce(
			new CloudRpcError("qorpera_begin_cloud_secret_capture", { message: "denied", code: "42501" }),
		);
		add("PACKAGES_TOKEN", "Packages", "fake-value-2");
		await settle();
		expect(outcome()).toBe("Only founders and admins can add, change or remove them.");
		forgotten("fake-value-2");
	});

	it("says an earlier try to save a value is still open, and replaces a name saved elsewhere meanwhile", async () => {
		const { client, state } = setup("company");
		await settle();
		const refused = () =>
			new CloudRpcError("qorpera_begin_cloud_secret_capture", { message: "duplicate key value", code: "23505" });
		// An earlier page's try left this variable's replacement open.
		vi.mocked(client.capture).mockRejectedValueOnce(refused());
		press(cardOf(companyLone.secretId)!, "Replace value");
		fill("New value for SENTRY_TOKEN", "fake-value-3");
		press(cardOf(companyLone.secretId)!, "Save value");
		await settle();
		expect(cardOf(companyLone.secretId)?.textContent).toContain(
			"An earlier try to save this value is still open. Try again in a few minutes.",
		);
		forgotten("fake-value-3");

		// Another admin saved the same new name meanwhile: the list is read again and the next try replaces it.
		vi.mocked(client.capture).mockImplementationOnce(async (input) => {
			state.variables.push({ ...companyLone, secretId: id(81), name: input.name, grants: [] });
			throw refused();
		});
		add("DEPLOY_KEY", "Deploys", "fake-value-4");
		await settle();
		expect(outcome()).toBe("It could not be changed. Try again.");
		expect(cardOf(id(81))).not.toBeNull();
		add("DEPLOY_KEY", "Deploys", "fake-value-5");
		await settle();
		expect(client.capture).toHaveBeenLastCalledWith(
			expect.objectContaining({ name: "DEPLOY_KEY", existingSecretId: id(81) }),
			expect.any(AbortSignal),
		);
	});

	it("replaces a value from its card, and keeps the form empty after a failure", async () => {
		const { client } = setup("company");
		await settle();
		press(cardOf(companyToken.secretId)!, "Replace value");
		const value = field("New value for NPM_TOKEN");
		// A textarea, so a multiline value keeps its line breaks.
		expect(value.tagName).toBe("TEXTAREA");
		expect(value.className).toBe("service-token");
		expect(value.getAttribute("rows")).toBe("3");
		expect(value.getAttribute("autocomplete")).toBe("off");
		expect(value.getAttribute("autocapitalize")).toBe("off");
		expect(value.getAttribute("spellcheck")).toBe("false");
		expect(document.activeElement).toBe(value);

		vi.mocked(client.capture).mockRejectedValueOnce(new Error("offline"));
		value.value = "fake-value-3";
		press(cardOf(companyToken.secretId)!, "Save value");
		await settle();
		expect(cardOf(companyToken.secretId)?.textContent).toContain("It could not be changed. Try again.");
		expect(field("New value for NPM_TOKEN").value).toBe("");
		forgotten("fake-value-3");

		field("New value for NPM_TOKEN").value = "fake-value-4";
		press(cardOf(companyToken.secretId)!, "Save value");
		expect(labels(cardOf(companyToken.secretId)!)).toContain("Saving…");
		await settle();
		expect(client.capture).toHaveBeenLastCalledWith(
			{
				ownerKind: "company",
				name: "NPM_TOKEN",
				purpose: "Installs private packages",
				value: "fake-value-4",
				existingSecretId: companyToken.secretId,
			},
			expect.any(AbortSignal),
		);
		expect(cardOf(companyToken.secretId)?.textContent).toContain(
			"The value of NPM_TOKEN is replaced. Coding sessions in acme/web get the new one from their next start.",
		);
		expect(view!.el.querySelector("textarea")).toBeNull();
		expect((document.activeElement as HTMLElement).dataset.focusKey).toBe(`coding-replace:${companyToken.secretId}`);
		forgotten("fake-value-4");
	});

	it("sends a pasted multiline value byte for byte, for a new variable and over an existing one", async () => {
		const { client } = setup("member", [memberOwn]);
		await settle();
		const added = "line one\nline two\r\nline three\n";
		press(view!.el, "Add a variable");
		expect(field("Value").tagName).toBe("TEXTAREA");
		fill("Variable name", "DEPLOY_KEY");
		fill("What it is for", "Clones private submodules");
		paste("Value", added);
		// The field reads its line breaks back as LF; the paste is what is sent.
		expect(field("Value").value).toBe("line one\nline two\nline three\n");
		press(view!.el.querySelector("form.hook-form")!, "Add");
		await settle();
		expect(client.capture).toHaveBeenLastCalledWith(
			expect.objectContaining({ name: "DEPLOY_KEY", value: added, existingSecretId: undefined }),
			expect.any(AbortSignal),
		);
		forgotten(added);

		const replaced = "fake key\r\nsecond line\r\nthird line\r\n";
		press(cardOf(memberOwn.secretId)!, "Replace value");
		paste("New value for GH_PACKAGES", replaced);
		press(cardOf(memberOwn.secretId)!, "Save value");
		await settle();
		expect(client.capture).toHaveBeenLastCalledWith(
			expect.objectContaining({ name: "GH_PACKAGES", value: replaced, existingSecretId: memberOwn.secretId }),
			expect.any(AbortSignal),
		);
		forgotten(replaced);

		// A value changed after its paste is sent as the field shows it.
		press(cardOf(memberOwn.secretId)!, "Replace value");
		paste("New value for GH_PACKAGES", "fake value\r\nmore");
		fill("New value for GH_PACKAGES", `${field("New value for GH_PACKAGES").value}!`);
		press(cardOf(memberOwn.secretId)!, "Save value");
		await settle();
		expect(client.capture).toHaveBeenLastCalledWith(
			expect.objectContaining({ value: "fake value\nmore!" }),
			expect.any(AbortSignal),
		);
	});

	it("refuses a short new value before any call", async () => {
		const { client } = setup("member");
		await settle();
		press(cardOf(memberOwn.secretId)!, "Replace value");
		field("New value for GH_PACKAGES").value = "fake-12";
		press(cardOf(memberOwn.secretId)!, "Save value");
		expect(cardOf(memberOwn.secretId)?.textContent).toContain("The value must be at least 8 characters.");
		expect(client.capture).not.toHaveBeenCalled();
		forgotten("fake-12");
	});

	it("removes a variable only after the member confirms", async () => {
		const { client } = setup("member");
		await settle();
		press(cardOf(memberOwn.secretId)!, "Remove");
		expect(dialog().textContent).toContain("Remove GH_PACKAGES? New coding sessions won't get it.");
		press(dialog(), "Cancel");
		await settle();
		expect(client.remove).not.toHaveBeenCalled();
		expect(cardOf(memberOwn.secretId)).not.toBeNull();

		press(cardOf(memberOwn.secretId)!, "Remove");
		press(dialog(), "Remove");
		await settle();
		expect(client.remove).toHaveBeenCalledWith(memberOwn.secretId, expect.any(AbortSignal));
		expect(cardOf(memberOwn.secretId)).toBeNull();
		expect(document.activeElement?.textContent).toBe("Add a variable");
	});

	it("takes a repository back only after the member confirms", async () => {
		const { client } = setup("company");
		await settle();
		const row = () => cardOf(companyToken.secretId)!.querySelector<HTMLElement>(`[data-grant="${webGrant.grantId}"]`);
		expect(buttons(row()!)[0]?.getAttribute("aria-label")).toBe("Remove acme/web");
		press(row()!, "Remove");
		expect(dialog().textContent).toContain("Coding sessions in acme/web will stop getting NPM_TOKEN.");
		press(dialog(), "Cancel");
		await settle();
		expect(client.revokeGrant).not.toHaveBeenCalled();
		expect(row()).not.toBeNull();

		press(row()!, "Remove");
		press(dialog(), "Remove");
		await settle();
		expect(client.revokeGrant).toHaveBeenCalledWith(webGrant.grantId, expect.any(AbortSignal));
		expect(client.remove).not.toHaveBeenCalled();
		expect(row()).toBeNull();
		expect(reach(companyToken.secretId)).toBe("No coding session gets it yet.");
	});

	it("gives a company variable to a repository, in lower case", async () => {
		const { client } = setup("company");
		await settle();
		press(cardOf(companyLone.secretId)!, "Give to a repository");
		const repository = field("Repository for SENTRY_TOKEN");
		expect(document.activeElement).toBe(repository);
		expect(cardOf(companyLone.secretId)?.textContent).toContain(
			"Coding sessions in that repository get SENTRY_TOKEN from their next start.",
		);
		repository.value = " Acme/Web ";
		repository.dispatchEvent(new Event("input"));
		press(cardOf(companyLone.secretId)!, "Add");
		await settle();
		expect(client.grant).toHaveBeenCalledWith(companyLone.secretId, "acme/web", expect.any(AbortSignal));
		expect(cardOf(companyLone.secretId)?.textContent).toContain(
			"Coding sessions in acme/web get SENTRY_TOKEN from their next start.",
		);
		expect(reach(companyLone.secretId)).toBe("Coding sessions in acme/web get it.");
		expect(view!.el.querySelector('input[aria-label="Repository for SENTRY_TOKEN"]')).toBeNull();
	});

	it("says how to write a repository, before the call and when the cloud refuses it", async () => {
		const { client } = setup("company");
		await settle();
		press(cardOf(companyLone.secretId)!, "Give to a repository");
		field("Repository for SENTRY_TOKEN").value = "acme web";
		field("Repository for SENTRY_TOKEN").dispatchEvent(new Event("input"));
		press(cardOf(companyLone.secretId)!, "Add");
		expect(cardOf(companyLone.secretId)?.textContent).toContain(
			"Write the repository as owner/name, for example acme/web.",
		);
		expect(client.grant).not.toHaveBeenCalled();
		// The form keeps what was written.
		expect(field("Repository for SENTRY_TOKEN").value).toBe("acme web");

		vi.mocked(client.grant).mockRejectedValueOnce(
			new CloudRpcError("qorpera_grant_coding_environment_secret", {
				message: "A repository is named owner/name",
				code: "22023",
			}),
		);
		field("Repository for SENTRY_TOKEN").value = "acme/web";
		field("Repository for SENTRY_TOKEN").dispatchEvent(new Event("input"));
		press(cardOf(companyLone.secretId)!, "Add");
		await settle();
		expect(client.grant).toHaveBeenCalledTimes(1);
		expect(cardOf(companyLone.secretId)?.textContent).toContain(
			"Write the repository as owner/name, for example acme/web.",
		);
	});

	it("shows a company's variables read-only to a member who isn't an owner or admin", async () => {
		setup("company", everything, { canManage: () => false });
		await settle();
		expect(view!.el.textContent).toContain("Only founders and admins can add, change or remove them.");
		expect(buttons(view!.el)).toEqual([]);
		expect(cards()).toEqual([companyToken.secretId, companyLone.secretId]);
		expect(reach(companyToken.secretId)).toBe("Coding sessions in acme/web get it.");
		expect(view!.el.querySelector("input, textarea")).toBeNull();
	});

	it("shows a viewer's own variables read-only, and redraws when the role changes", async () => {
		const role = { write: false };
		setup("member", everything, { canManage: () => role.write });
		await settle();
		expect(view!.el.textContent).toContain("Viewers can see them, but not add or change them.");
		expect(buttons(view!.el)).toEqual([]);
		expect(reach(memberToken.secretId)).toBe(
			"Your coding sessions get it. In acme/web, the company's NPM_TOKEN is used instead.",
		);

		role.write = true;
		view!.update();
		expect(view!.el.textContent).not.toContain("Viewers can see them");
		expect(labels(view!.el)).toContain("Add a variable");
		press(view!.el, "Add a variable");
		press(cardOf(memberOwn.secretId)!, "Replace value");
		expect(view!.el.querySelector('textarea[aria-label="New value for GH_PACKAGES"]')).not.toBeNull();

		// Losing the right closes every form.
		role.write = false;
		view!.update();
		expect(buttons(view!.el)).toEqual([]);
		expect(view!.el.querySelector("input, textarea")).toBeNull();
	});

	it("says when the list could not be read, and reads it again", async () => {
		const { client } = setup("member", everything, manager, (mock) => {
			vi.mocked(mock.list).mockRejectedValueOnce(new Error("offline"));
		});
		await settle();
		expect(view!.el.querySelector('[role="alert"]')?.textContent).toContain(
			"The environment variables could not be read.",
		);
		expect(cards()).toEqual([]);
		press(view!.el, "Try again");
		await settle();
		expect(client.list).toHaveBeenCalledTimes(2);
		expect(view!.el.querySelector('[role="alert"]')).toBeNull();
		expect(cards()).toEqual([memberToken.secretId, memberOwn.secretId]);
	});

	// The view tells whoever it is given, for either owner; Settings gives it only to the company's, since a member's
	// own variables change nothing the company's tab shows.
	it("tells the other tab after each change that reached the cloud, once its own read has started", async () => {
		const onChange = vi.fn();
		const { client } = setup("company", everything, manager, undefined, onChange);
		await settle();
		/** onChange was called this often, the last time just after a read that started after the change. */
		const told = (times: number, change: { mock: { invocationCallOrder: number[] } }) => {
			expect(onChange).toHaveBeenCalledTimes(times);
			const read = vi.mocked(client.list).mock.invocationCallOrder.at(-1)!;
			expect(read).toBeGreaterThan(change.mock.invocationCallOrder.at(-1)!);
			expect(read).toBeLessThan(onChange.mock.invocationCallOrder.at(-1)!);
		};

		// Refused before any call: nothing changed.
		press(cardOf(companyLone.secretId)!, "Give to a repository");
		fill("Repository for SENTRY_TOKEN", "acme web");
		press(cardOf(companyLone.secretId)!, "Add");
		expect(onChange).not.toHaveBeenCalled();
		fill("Repository for SENTRY_TOKEN", "acme/api");
		press(cardOf(companyLone.secretId)!, "Add");
		await settle();
		told(1, vi.mocked(client.grant));

		// Not confirmed: nothing changed.
		const row = () =>
			cardOf(companyToken.secretId)!.querySelector<HTMLElement>(`[data-grant="${webGrant.grantId}"]`)!;
		press(row(), "Remove");
		press(dialog(), "Cancel");
		await settle();
		expect(onChange).toHaveBeenCalledTimes(1);
		press(row(), "Remove");
		press(dialog(), "Remove");
		await settle();
		told(2, vi.mocked(client.revokeGrant));

		press(cardOf(companyToken.secretId)!, "Replace value");
		fill("New value for NPM_TOKEN", "fake-value-3");
		press(cardOf(companyToken.secretId)!, "Save value");
		await settle();
		told(3, vi.mocked(client.capture));

		add("DEPLOY_KEY", "Deploys", "fake-value-4");
		await settle();
		told(4, vi.mocked(client.capture));

		press(cardOf(companyLone.secretId)!, "Remove");
		press(dialog(), "Remove");
		await settle();
		told(5, vi.mocked(client.remove));

		// A refusal may still have changed something, so the other tab reads too.
		vi.mocked(client.capture).mockRejectedValueOnce(new Error("offline"));
		press(cardOf(companyToken.secretId)!, "Replace value");
		fill("New value for NPM_TOKEN", "fake-value-5");
		press(cardOf(companyToken.secretId)!, "Save value");
		await settle();
		expect(cardOf(companyToken.secretId)?.textContent).toContain("It could not be changed. Try again.");
		told(6, vi.mocked(client.capture));
	});

	it("reads its list again when the other tab changed it, and not once it is gone", async () => {
		const { client, state } = setup("member");
		await settle();
		expect(reach(memberToken.secretId)).toBe(
			"Your coding sessions get it. In acme/web, the company's NPM_TOKEN is used instead.",
		);
		// Company connections takes the company's NPM_TOKEN back from acme/web.
		state.variables.find((variable) => variable.secretId === companyToken.secretId)!.grants = [];
		view!.reload();
		await settle();
		expect(client.list).toHaveBeenCalledTimes(2);
		expect(reach(memberToken.secretId)).toBe("Your coding sessions get it.");

		view!.dispose();
		view!.reload();
		await settle();
		expect(client.list).toHaveBeenCalledTimes(2);
	});
});
