import { randomUUID } from "node:crypto";
import { parseCloudSkillFile } from "@qorpera/cloud-client/cloud-skill-file";
import type { CloudCompanyPathGateway, CloudCompanyPathResult } from "@qorpera/runtime/cloud-company-path-gateway";
import { CloudCompanyPathNotText } from "@qorpera/runtime/cloud-company-path-gateway";
import {
	CloudCompanyPathParentMissing,
	CloudCompanyPathRpcRefusal,
	CloudCompanyPathToolRefusal,
	CloudCompanyPathVersionChanged,
} from "@qorpera/runtime/cloud-company-path-refusal";
import { CloudNativeToolRun } from "@qorpera/runtime/cloud-native-tool-authority";
import { CloudNativeToolBoundary, MAX_CLOUD_TOOL_RESULT_BYTES } from "@qorpera/runtime/cloud-native-tool-boundary";
import { cloudSkillRoot, cloudSkillTools, composeCloudAgentSkills } from "@qorpera/runtime/cloud-skill-tools";
import { describe, expect, it, vi } from "vitest";
import { nativeToolAuthorityFixture } from "./fixtures/native-tool-authority-fixture.ts";

/** An in-memory Company File behind the gateway's trusted reads and governed writes: versioned
 * text objects and real folder entries (the gateway never invents a parent). A stale expected
 * version fails the way the real gateway reports it. */
function companyFile(initial: Record<string, string> = {}) {
	const files = new Map<string, { version: string; text: string }>();
	const folders = new Set<string>();
	const unreadable = new Set<string>();
	/** Paths a narrower grant keeps from this run: refused reads, and refused changes. */
	const deniedReads = new Set<string>();
	const deniedChanges = new Set<string>();
	/** Protected folders: a new folder inside one is proposed, not created. */
	const protectedFolders = new Set<string>();
	/** Listings that fail (the library cannot be read). */
	const unlistable = new Set<string>();
	/** One write whose folder vanished before its commit. */
	let parentVanishes = false;
	const parent = (path: string) => path.split("/").slice(0, -1).join("/");
	const addFolders = (path: string) => {
		for (let folder = parent(path); folder; folder = parent(folder)) folders.add(folder);
	};
	for (const [path, text] of Object.entries(initial)) {
		if (path.endsWith("/")) folders.add(path.slice(0, -1));
		else files.set(path, { version: randomUUID(), text });
		addFolders(path.endsWith("/") ? path.slice(0, -1) : path);
	}
	/** Queued races, taken one per write: "head" moves the company head only (the skill itself is
	 * unchanged), "edit" is another writer changing the skill first. */
	const races: ("head" | "edit")[] = [];
	const result = (path: string, version: string | null, state: CloudCompanyPathResult["state"] = "applied") => ({
		schema: "qorpera.company-path-result/v1" as const,
		state,
		operationKey: "key",
		path,
		version,
		snapshotId: randomUUID(),
		receiptId: randomUUID(),
		proposalId: state === "proposed" ? randomUUID() : null,
	});
	const readTrusted = vi.fn<CloudCompanyPathGateway["readTrusted"]>(async (path) => {
		if (unreadable.has(path)) throw new CloudCompanyPathNotText();
		if (deniedReads.has(path)) throw new CloudCompanyPathRpcRefusal();
		const file = files.get(path);
		if (file) return { path, version: file.version, kind: "file", text: file.text, fileSha256: "a".repeat(64) };
		return folders.has(path)
			? { path, version: randomUUID(), kind: "directory", text: "", fileSha256: null }
			: { path, version: null, kind: "absent", text: "", fileSha256: null };
	});
	const listTrusted = vi.fn<CloudCompanyPathGateway["listTrusted"]>(async (path) => {
		if (unlistable.has(path)) throw new Error("Company File listing unavailable");
		const child = (key: string) => key.startsWith(`${path}/`) && !key.slice(path.length + 1).includes("/");
		return [
			...[...folders].filter(child).map((key) => ({
				path: key,
				version: randomUUID(),
				kind: "directory" as const,
				bytes: null,
			})),
			...[...files.entries()]
				.filter(([key]) => child(key))
				.map(([key, file]) => ({
					path: key,
					version: file.version,
					kind: "file" as const,
					bytes: file.text.length,
				})),
		].sort((a, b) => (a.path < b.path ? -1 : 1));
	});
	const mutate = vi.fn<CloudCompanyPathGateway["mutate"]>(async (operation, input) => {
		if (parent(input.path) && !folders.has(parent(input.path))) throw new Error("Company File parent is absent");
		if (deniedChanges.has(input.path)) throw new CloudCompanyPathToolRefusal();
		if (operation === "mkdir") {
			if (folders.has(input.path) || files.has(input.path)) throw new CloudCompanyPathVersionChanged();
			if (protectedFolders.has(parent(input.path))) return result(input.path, null, "proposed");
			folders.add(input.path);
			return result(input.path, randomUUID());
		}
		if (parentVanishes) {
			parentVanishes = false;
			throw new CloudCompanyPathParentMissing();
		}
		const current = files.get(input.path) ?? null;
		if ((current?.version ?? null) !== input.expectedVersion) throw new CloudCompanyPathVersionChanged();
		const race = races.shift();
		if (race === "edit") files.set(input.path, { version: randomUUID(), text: `${current?.text ?? ""}edited\n` });
		if (race) throw new CloudCompanyPathVersionChanged();
		// Deleting is always proposal-gated in the kernel.
		if (operation === "delete") return result(input.path, current?.version ?? null, "proposed");
		const version = randomUUID();
		files.set(input.path, { version, text: input.text as string });
		return result(input.path, version);
	});
	return {
		files,
		folders,
		unreadable,
		deniedReads,
		deniedChanges,
		protectedFolders,
		unlistable,
		races,
		vanishParent: () => {
			parentVanishes = true;
		},
		gateway: { readTrusted, listTrusted, mutate },
		mutate,
		listTrusted,
	};
}

/** Every agent's folder is its folder name (legacy sweep step C, AF). */
const PLACE = { core: "folder-v2", handle: "nora" } as const;

async function fixture(initial: Record<string, string> = {}) {
	const { binding, authority } = nativeToolAuthorityFixture();
	const run = await CloudNativeToolRun.open(
		binding,
		{ describeToolAuthority: async () => authority },
		new AbortController().signal,
	);
	// The agent's folder name: its own library is under agents/<agent>/skills.
	const agent = PLACE.handle;
	const own = cloudSkillRoot("agent", run.identity, PLACE);
	expect(own).toBe("agents/nora/skills");
	expect(cloudSkillRoot("agent", run.identity, { core: "folder-v2", handle: "anna-berg" })).toBe(
		"agents/anna-berg/skills",
	);
	expect(cloudSkillRoot("company", run.identity, { core: "folder-v2", handle: "anna-berg" })).toBe(
		cloudSkillRoot("company", run.identity, PLACE),
	);
	const store = companyFile(
		Object.fromEntries(Object.entries(initial).map(([key, text]) => [key.replace("<own>", own), text])),
	);
	const boundary = new CloudNativeToolBoundary({
		companyId: run.identity.companyId,
		runId: run.identity.runId,
		identity: run.identity,
		tools: cloudSkillTools(store.gateway, run.identity, PLACE),
		assertActive: (signal) => run.assertActive(signal),
		signal: run.signal,
	});
	const call = async (tool: string, args: Record<string, unknown>) => {
		const result = await boundary.invoke(randomUUID(), "qorpera", tool, args as never);
		expect(result.success, JSON.stringify(result)).toBe(true);
		const fenced = JSON.parse(result.contentItems[0].text);
		expect(fenced.content.truncated).toBe(false);
		expect(Buffer.byteLength(result.contentItems[0].text)).toBeLessThanOrEqual(MAX_CLOUD_TOOL_RESULT_BYTES);
		return JSON.parse(fenced.content.text);
	};
	/** The current version of a stored file, as read_skill or a receipt would give it. */
	const version = (path: string) => store.files.get(path.replace("<own>", own))!.version;
	/** The skills block the runtime composes for this run. */
	const compose = () => composeCloudAgentSkills(store.gateway, run.identity, new AbortController().signal, PLACE);
	return { run, agent, own, store, boundary, call, version, compose };
}

const imported = [
	"---",
	"name: pdf-forms",
	"description: >-",
	"  Fill in PDF forms and flatten them.",
	"  Use when a member sends a PDF form.",
	"license: Apache-2.0",
	"metadata:",
	"  author: someone",
	"---",
	"",
	"# PDF forms",
	"",
	"1. Read the form fields.",
	"",
].join("\n");

describe("agent skills", () => {
	it("creates an own skill in the shared SKILL.md layout, with its folders, and refuses a second of the same name", async () => {
		const f = await fixture();
		try {
			const created = await f.call("update_skill", {
				action: "create",
				name: "monthly-vat-report",
				description: "Prepare the monthly VAT report. Use at the start of each month.",
				body: "1. Export the ledger.\n2. Sum the VAT lines.",
			});
			const path = `${f.own}/monthly-vat-report/SKILL.md`;
			expect(created).toMatchObject({
				schema: "qorpera.agent-skill-receipt/v1",
				action: "create",
				scope: "agent",
				state: "created",
				path,
			});
			expect(f.store.files.get(path)?.text).toBe(
				'---\nname: monthly-vat-report\ndescription: "Prepare the monthly VAT report. Use at the start of each month."\n---\n\n1. Export the ledger.\n2. Sum the VAT lines.\n',
			);
			const mkdirs = f.store.mutate.mock.calls.filter(([operation]) => operation === "mkdir");
			expect(mkdirs.map(([, input]) => input.path)).toEqual([
				"agents",
				`agents/${f.agent}`,
				f.own,
				`${f.own}/monthly-vat-report`,
			]);
			for (const [, input] of mkdirs) expect(input.operationKey).toMatch(/^skill-folder-[0-9a-f]{40}$/);
			const write = f.store.mutate.mock.calls.find(([operation]) => operation === "write")!;
			expect(write[1]).toMatchObject({
				expectedVersion: null,
				operationKey: expect.stringMatching(/^skill-create-/),
			});
			const again = await f.call("update_skill", {
				action: "create",
				name: "monthly-vat-report",
				description: "Another.",
				body: "Other steps.",
			});
			expect(again).toMatchObject({ state: "exists", saved: false, path });
			expect(f.store.mutate.mock.calls.filter(([operation]) => operation === "write")).toHaveLength(1);
		} finally {
			f.run.close();
		}
	});

	it("puts a company skill in the shared library under the usual path authority", async () => {
		const f = await fixture({ "skills/": "" });
		try {
			const created = await f.call("update_skill", {
				action: "create",
				scope: "company",
				name: "customer-refund",
				description: "Refund a customer. Use when a refund is approved.",
				body: "Steps.",
			});
			expect(created).toMatchObject({ scope: "company", state: "created", path: "skills/customer-refund/SKILL.md" });
			// Only the skill's own folder was missing.
			expect(
				f.store.mutate.mock.calls.filter(([operation]) => operation === "mkdir").map(([, input]) => input.path),
			).toEqual(["skills/customer-refund"]);
		} finally {
			f.run.close();
		}
	});

	it("updates the body or the description and keeps the rest of an imported file", async () => {
		const f = await fixture({ "skills/pdf-forms/SKILL.md": imported });
		try {
			const read = await f.call("read_skill", { name: "pdf-forms" });
			const body = await f.call("update_skill", {
				action: "update",
				scope: "company",
				name: "pdf-forms",
				version: read.version,
				body: "1. Read the fields.\n2. Flatten.",
			});
			expect(body).toMatchObject({ state: "updated", saved: true, path: "skills/pdf-forms/SKILL.md" });
			expect(body.version).toBe(f.version("skills/pdf-forms/SKILL.md"));
			const text = f.store.files.get("skills/pdf-forms/SKILL.md")!.text;
			expect(text).toContain("license: Apache-2.0\nmetadata:\n  author: someone\n");
			expect(text).toContain("description: >-\n  Fill in PDF forms and flatten them.");
			expect(text.endsWith("---\n\n1. Read the fields.\n2. Flatten.\n")).toBe(true);
			// The receipt's version is the one to name next.
			const unchanged = await f.call("update_skill", {
				action: "update",
				scope: "company",
				name: "pdf-forms",
				version: body.version,
				body: "1. Read the fields.\n2. Flatten.",
			});
			expect(unchanged).toMatchObject({ state: "unchanged", saved: true });
			const missing = await f.call("update_skill", {
				action: "update",
				name: "pdf-forms",
				version: body.version,
				body: "x",
			});
			// scope defaults to the agent's own library, which has no such skill.
			expect(missing).toMatchObject({ state: "not_found", saved: false, scope: "agent" });
		} finally {
			f.run.close();
		}
	});

	it("redoes a change after the company head moved, but never overwrites another writer's edit", async () => {
		const f = await fixture({ "<own>/triage/SKILL.md": "---\nname: triage\ndescription: Triage.\n---\n\nOld.\n" });
		const path = "<own>/triage/SKILL.md";
		try {
			f.store.races.push("head");
			const redone = await f.call("update_skill", {
				action: "update",
				name: "triage",
				version: f.version(path),
				body: "New.",
			});
			expect(redone).toMatchObject({ state: "updated" });
			expect(f.store.files.get(`${f.own}/triage/SKILL.md`)?.text).toContain("\n\nNew.\n");
			f.store.races.push("edit");
			const raced = await f.call("update_skill", {
				action: "update",
				name: "triage",
				version: redone.version,
				body: "Mine.",
			});
			expect(raced).toMatchObject({ state: "changed", saved: false, version: f.version(path) });
			expect(f.store.files.get(`${f.own}/triage/SKILL.md`)?.text).toContain("edited");
			expect(f.store.files.get(`${f.own}/triage/SKILL.md`)?.text).not.toContain("Mine.");
			// An edit between the agent's read and its update: the stale version saves nothing.
			const stale = await f.call("update_skill", {
				action: "update",
				name: "triage",
				version: redone.version,
				body: "Stale.",
			});
			expect(stale).toMatchObject({ state: "changed", saved: false });
			f.store.races.push("head", "head", "head");
			const lost = await f.call("update_skill", {
				action: "update",
				name: "triage",
				version: f.version(path),
				body: "Again.",
			});
			expect(lost).toMatchObject({ state: "conflict", saved: false });
		} finally {
			f.run.close();
		}
	});

	it("deletes through the governed gateway, where a member approves it", async () => {
		const f = await fixture({ "<own>/old-way/SKILL.md": "---\nname: old-way\ndescription: Old.\n---\n\nx\n" });
		try {
			const deleted = await f.call("update_skill", {
				action: "delete",
				name: "old-way",
				version: f.version("<own>/old-way/SKILL.md"),
			});
			expect(deleted).toMatchObject({ state: "proposed", proposalId: expect.any(String) });
			expect(deleted.hint).toMatch(/member's approval/);
			const [, input] = f.store.mutate.mock.calls.find(([operation]) => operation === "delete")!;
			expect(input).toMatchObject({
				path: `${f.own}/old-way/SKILL.md`,
				expectedVersion: f.store.files.get(`${f.own}/old-way/SKILL.md`)!.version,
			});
		} finally {
			f.run.close();
		}
	});

	it("refuses malformed requests before any read", async () => {
		const f = await fixture();
		try {
			for (const args of [
				{ action: "create", name: "Bad Name", description: "x", body: "x" },
				{ action: "create", name: "a--b", description: "x", body: "x" },
				{ action: "create", name: "no-body", description: "x" },
				{ action: "update", name: "nothing-to-change", version: "10000000-0000-4000-8000-000000000001" },
				{ action: "delete", name: "with-body", version: "10000000-0000-4000-8000-000000000001", body: "x" },
				{ action: "update", name: "no-version", body: "x" },
				{ action: "delete", name: "no-version" },
				{ action: "update", name: "bad-version", version: "v1", body: "x" },
				{
					action: "create",
					name: "has-version",
					version: "10000000-0000-4000-8000-000000000001",
					description: "x",
					body: "x",
				},
				{ action: "create", name: "own", scope: "member", description: "x", body: "x" },
				{ action: "create", name: "long", description: "x".repeat(1025), body: "x" },
			]) {
				const result = await f.boundary.invoke(randomUUID(), "qorpera", "update_skill", args as never);
				expect(result.success, JSON.stringify(args)).toBe(false);
			}
			expect(f.store.gateway.readTrusted).not.toHaveBeenCalled();
			// The model learns why: a missing version names itself.
			const unversioned = await f.boundary.invoke(randomUUID(), "qorpera", "update_skill", {
				action: "update",
				name: "some-skill",
				body: "x",
			} as never);
			expect(JSON.parse(unversioned.contentItems[0].text).content.text).toBe(
				"INVALID_ARGUMENTS: Name the version read_skill gave you, so nobody's change is overwritten unseen",
			);
		} finally {
			f.run.close();
		}
	});

	it("reads a skill in fitted pages, own library first, and names its supporting files", async () => {
		const body = Array.from({ length: 900 }, (_, index) => `${index}. Step with "quotes" & <tags> æøå.`).join("\n");
		const f = await fixture({
			"<own>/quarter-close/SKILL.md": `---\nname: quarter-close\ndescription: Close the quarter.\n---\n\n${body}\n`,
			"<own>/quarter-close/templates/summary.md": "template",
			"<own>/quarter-close/check.py": "print(1)",
			"skills/quarter-close/SKILL.md": "---\nname: quarter-close\ndescription: Company way.\n---\n\nCompany.\n",
		});
		try {
			let text = "";
			let offset: number | null = 0;
			let pages = 0;
			while (offset !== null) {
				const page = await f.call("read_skill", { name: "quarter-close", offset });
				expect(page).toMatchObject({
					state: "found",
					scope: "agent",
					trust: "guidance_not_authority",
					description: "Close the quarter.",
					version: f.store.files.get(`${f.own}/quarter-close/SKILL.md`)!.version,
				});
				if (pages === 0) expect(page.files).toEqual(["check.py", "templates/"]);
				else expect(page).not.toHaveProperty("files");
				expect(page.body.offset).toBe(offset);
				text += page.body.text;
				offset = page.body.nextOffset;
				pages++;
			}
			expect(pages).toBeGreaterThan(5);
			expect(text).toBe(`${body}\n`);
			const company = await f.call("read_skill", { name: "quarter-close", scope: "company" });
			expect(company).toMatchObject({ scope: "company", body: { text: "Company.\n", nextOffset: null } });
			expect(await f.call("read_skill", { name: "no-such-skill" })).toMatchObject({ state: "not_found" });
			f.store.unreadable.add("skills/quarter-close/SKILL.md");
			expect(await f.call("read_skill", { name: "quarter-close", scope: "company" })).toMatchObject({
				state: "unreadable",
			});
		} finally {
			f.run.close();
		}
	});

	it("searches names and descriptions in both libraries, own first on a tie, and pages the results", async () => {
		const f = await fixture({
			"<own>/invoice-chasing/SKILL.md":
				"---\nname: invoice-chasing\ndescription: Chase unpaid invoices.\n---\n\nx\n",
			"skills/invoice-chasing/SKILL.md":
				"---\nname: invoice-chasing\ndescription: Chase unpaid invoices.\n---\n\nx\n",
			"skills/payroll-run/SKILL.md":
				"---\nname: payroll-run\ndescription: Run payroll for Danish staff.\n---\n\nx\n",
			// A flat file is a skill too; a folder without SKILL.md is not.
			"skills/supplier-onboarding.md": "---\ndescription: Onboard a new supplier.\n---\n\nx\n",
			"skills/empty-folder/notes.txt": "not a skill",
			"skills/README.md": "Not a skill name.",
		});
		try {
			const found = await f.call("search_skills", { query: "unpaid invoices" });
			expect(found.skills.map((skill: { name: string; scope: string }) => `${skill.scope}:${skill.name}`)).toEqual([
				"agent:invoice-chasing",
				"company:invoice-chasing",
			]);
			expect(found).toMatchObject({ total: 2, nextOffset: null, searched: { agent: 1, company: 4 } });
			const danish = await f.call("search_skills", { query: "danish", scope: "company" });
			expect(danish.skills).toEqual([
				{ name: "payroll-run", description: "Run payroll for Danish staff.", scope: "company" },
			]);
			const all = await f.call("search_skills", { scope: "company", limit: 2 });
			expect(all.skills.map((skill: { name: string }) => skill.name)).toEqual(["invoice-chasing", "payroll-run"]);
			expect(all).toMatchObject({ total: 3, nextOffset: 2 });
			const rest = await f.call("search_skills", { scope: "company", limit: 2, offset: 2 });
			expect(rest.skills).toEqual([
				{ name: "supplier-onboarding", description: "Onboard a new supplier.", scope: "company" },
			]);
			expect(rest.nextOffset).toBeNull();
		} finally {
			f.run.close();
		}
	});

	it("keeps a search page inside one result even when every description is long", async () => {
		const long = "Use this when ".concat("the ledger needs attention ".repeat(36)).trim();
		const f = await fixture(
			Object.fromEntries(
				Array.from({ length: 12 }, (_, index) => [
					`skills/ledger-${String(index).padStart(2, "0")}/SKILL.md`,
					`---\nname: ledger-${index}\ndescription: ${long}\n---\n\nx\n`,
				]),
			),
		);
		try {
			const first = await f.call("search_skills", { query: "ledger" });
			expect(first.skills.length).toBeGreaterThan(0);
			expect(first.skills.length).toBeLessThan(12);
			expect(first.nextOffset).toBe(first.skills.length);
			const next = await f.call("search_skills", { query: "ledger", offset: first.nextOffset });
			expect(next.skills[0].name).toBe(`ledger-${String(first.skills.length).padStart(2, "0")}`);
		} finally {
			f.run.close();
		}
	});
});

describe("imported skills with long descriptions", () => {
	it("cuts a description past the bound in the catalog, the search and a read", async () => {
		const long = "Ærlig beskrivelse ".repeat(200).trim();
		const f = await fixture({
			"skills/long-one/SKILL.md": `---\nname: long-one\ndescription: ${long}\n---\n\nSteps.\n`,
		});
		try {
			const block = await f.compose();
			const [entry] = block.company.skills;
			expect(Buffer.byteLength(entry.description!)).toBeLessThanOrEqual(1100);
			expect(entry.description!.endsWith("…")).toBe(true);
			expect(long.startsWith(entry.description!.slice(0, -1))).toBe(true);
			const found = await f.call("search_skills", { query: "beskrivelse" });
			expect(found.skills).toEqual([{ name: "long-one", description: entry.description, scope: "company" }]);
			const read = await f.call("read_skill", { name: "long-one" });
			expect(read).toMatchObject({ description: entry.description, body: { text: "Steps.\n", nextOffset: null } });
		} finally {
			f.run.close();
		}
	});
});

describe("skill catalog composition", () => {
	it("composes own skills with descriptions and a small company library with its descriptions", async () => {
		const f = await fixture({
			"<own>/triage/SKILL.md": "---\nname: triage\ndescription: Triage new tickets.\n---\n\nx\n",
			"<own>/broken/SKILL.md": "No front matter at all.",
			"<own>/empty/": "",
			"skills/refund/SKILL.md": "---\nname: refund\ndescription: Refund a customer.\n---\n\nx\n",
		});
		try {
			f.store.unreadable.add("skills/refund/SKILL.md");
			const block = await f.compose();
			expect(block).toEqual({
				schema: "qorpera.agent-skills/v1",
				trust: "guidance_not_authority",
				available: true,
				tools: ["read_skill", "search_skills", "update_skill"],
				own: {
					path: f.own,
					skills: [
						{ name: "broken", problem: "no_description" },
						{ name: "triage", description: "Triage new tickets." },
					],
					moreSkills: 0,
				},
				company: {
					path: "skills",
					descriptions: "included",
					skills: [{ name: "refund", problem: "unreadable" }],
					moreSkills: 0,
				},
			});
			// The catalog reads only SKILL.md files: never a body page, never another agent's library.
			for (const [path] of f.store.gateway.readTrusted.mock.calls) expect(path).toMatch(/\/SKILL\.md$/);
		} finally {
			f.run.close();
		}
	});

	it("names a grown company library instead of describing it", async () => {
		const f = await fixture(
			Object.fromEntries(
				Array.from({ length: 30 }, (_, index) => [
					`skills/skill-${String(index).padStart(2, "0")}/SKILL.md`,
					`---\nname: skill-${index}\ndescription: Skill ${index}.\n---\n\nx\n`,
				]),
			),
		);
		try {
			const block = await f.compose();
			expect(block.company).toMatchObject({ descriptions: "search_skills", moreSkills: 0 });
			expect(block.company.skills).toHaveLength(30);
			expect(block.company.skills[0]).toEqual({ name: "skill-00" });
			// Names come from one listing: no company skill file was read.
			expect(f.store.gateway.readTrusted).not.toHaveBeenCalled();
		} finally {
			f.run.close();
		}
	});

	it("keeps one library when the other cannot be listed, and fails only when neither can", async () => {
		const f = await fixture({
			"<own>/triage/SKILL.md": "---\nname: triage\ndescription: Triage.\n---\n\nx\n",
			"skills/refund/SKILL.md": "---\nname: refund\ndescription: Refund.\n---\n\nx\n",
		});
		try {
			f.store.unlistable.add("skills");
			const block = await f.compose();
			expect(block.available).toBe(true);
			expect(block.own.skills).toEqual([{ name: "triage", description: "Triage." }]);
			expect(block.own).not.toHaveProperty("unavailable");
			expect(block.company).toMatchObject({ skills: [], unavailable: "unknown" });
			// A search still covers the library it can read, and says which one it could not.
			const found = await f.call("search_skills", {});
			expect(found).toMatchObject({ total: 1, searched: { agent: 1 }, unavailable: ["company"] });
			f.store.unlistable.add(f.own);
			await expect(f.compose()).rejects.toThrow("Company File listing unavailable");
		} finally {
			f.run.close();
		}
	});
});

describe("refusals and protected libraries", () => {
	it("proposes the folder of a new skill in a protected library and saves nothing yet", async () => {
		const f = await fixture({ "skills/": "" });
		try {
			f.store.protectedFolders.add("skills");
			const created = await f.call("update_skill", {
				action: "create",
				scope: "company",
				name: "refund",
				description: "Refund a customer.",
				body: "Steps.",
			});
			expect(created).toMatchObject({
				state: "proposed",
				saved: false,
				path: "skills/refund",
				proposalId: expect.any(String),
			});
			expect(created.hint).toMatch(/approve/);
			expect(f.store.mutate.mock.calls.some(([operation]) => operation === "write")).toBe(false);
		} finally {
			f.run.close();
		}
	});

	it("answers refused and interrupted saves with receipts, never an unknown outcome", async () => {
		const f = await fixture({
			"skills/refund/SKILL.md": "---\nname: refund\ndescription: Refund.\n---\n\nx\n",
		});
		try {
			f.store.deniedChanges.add("skills/new-one");
			const refused = await f.call("update_skill", {
				action: "create",
				scope: "company",
				name: "new-one",
				description: "New.",
				body: "Steps.",
			});
			expect(refused).toMatchObject({ state: "denied", saved: false });
			f.store.deniedReads.add("skills/other/SKILL.md");
			const unreadFolder = await f.call("update_skill", {
				action: "create",
				scope: "company",
				name: "other",
				description: "Other.",
				body: "Steps.",
			});
			expect(unreadFolder).toMatchObject({ state: "denied", saved: false, path: "skills/other/SKILL.md" });
			f.store.vanishParent();
			const vanished = await f.call("update_skill", {
				action: "update",
				scope: "company",
				name: "refund",
				version: f.version("skills/refund/SKILL.md"),
				body: "New steps.",
			});
			expect(vanished).toMatchObject({ state: "parent_missing", saved: false });
			expect(f.store.files.get("skills/refund/SKILL.md")?.text).toContain("\n\nx\n");
			f.store.deniedReads.add("skills/refund/SKILL.md");
			expect(await f.call("read_skill", { name: "refund", scope: "company" })).toMatchObject({ state: "no_access" });
			const block = await f.compose();
			expect(block.company.skills).toEqual([{ name: "refund", problem: "no_access" }]);
		} finally {
			f.run.close();
		}
	});

	it("reads the company skill when the own library cannot be read, and says changed between pages", async () => {
		const f = await fixture({ "skills/refund/SKILL.md": "---\nname: refund\ndescription: Refund.\n---\n\nSteps.\n" });
		try {
			f.store.gateway.readTrusted.mockImplementation(async (path) => {
				if (path.startsWith(f.own)) throw new Error("Company File read unavailable");
				const file = f.store.files.get(path);
				return file
					? { path, version: file.version, kind: "file", text: file.text, fileSha256: "a".repeat(64) }
					: { path, version: null, kind: "absent", text: "", fileSha256: null };
			});
			const read = await f.call("read_skill", { name: "refund" });
			expect(read).toMatchObject({
				state: "found",
				scope: "company",
				ownUnavailable: true,
				body: { text: "Steps.\n" },
			});
			const stale = await f.call("read_skill", {
				name: "refund",
				offset: 3,
				version: "10000000-0000-4000-8000-000000000001",
			});
			expect(stale).toMatchObject({ state: "changed", version: read.version });
		} finally {
			f.run.close();
		}
	});

	it("keeps paging when descriptions are full of markup the fence escapes", async () => {
		const markup = "<&>".repeat(300);
		const f = await fixture(
			Object.fromEntries(
				Array.from({ length: 6 }, (_, index) => [
					`skills/markup-${index}/SKILL.md`,
					`---\nname: markup-${index}\ndescription: "${markup}"\n---\n\n${"<b>&amp;</b>\n".repeat(400)}`,
				]),
			),
		);
		try {
			let offset: number | null = 0;
			const seen: string[] = [];
			while (offset !== null) {
				const page = await f.call("search_skills", { offset });
				expect(page.skills.length).toBeGreaterThan(0);
				seen.push(...page.skills.map((skill: { name: string }) => skill.name));
				offset = page.nextOffset;
			}
			expect(seen).toHaveLength(6);
			let text = "";
			offset = 0;
			while (offset !== null) {
				const page = await f.call("read_skill", { name: "markup-0", offset });
				expect(page.state).toBe("found");
				expect(page.description.endsWith("…")).toBe(true);
				text += page.body.text;
				offset = page.body.nextOffset;
			}
			expect(text).toBe("<b>&amp;</b>\n".repeat(400));
		} finally {
			f.run.close();
		}
	});

	it("keeps a file's own line endings and reads YAML escapes and comment lines", async () => {
		const crlf = "---\r\nname: windows\r\ndescription: Made on Windows.\r\n---\r\n\r\nOld.\r\n";
		const f = await fixture({ "<own>/windows/SKILL.md": crlf });
		try {
			const updated = await f.call("update_skill", {
				action: "update",
				name: "windows",
				version: f.version("<own>/windows/SKILL.md"),
				body: "New.\nSteps.",
			});
			expect(updated.state).toBe("updated");
			expect(f.store.files.get(`${f.own}/windows/SKILL.md`)?.text).toBe(
				"---\r\nname: windows\r\ndescription: Made on Windows.\r\n---\r\n\r\nNew.\r\nSteps.\r\n",
			);
			// A version is matched whatever its letter case.
			const upper = await f.call("update_skill", {
				action: "update",
				name: "windows",
				version: updated.version.toUpperCase(),
				body: "Newer.",
			});
			expect(upper.state).toBe("updated");
		} finally {
			f.run.close();
		}
		expect(parseCloudSkillFile('---\ndescription: "Tab\\there, \\x41 and \\u00e6"\n---\n').description).toBe(
			// \\t is a tab, which a description folds into one space.
			"Tab here, A and æ",
		);
		expect(
			parseCloudSkillFile("---\ndescription: first part\n  # a comment line\n  second part\n---\n").description,
		).toBe("first part second part");
		// Inside quotes a # line is text.
		expect(parseCloudSkillFile('---\ndescription: "first\n  # second"\n---\n').description).toBe("first # second");
		// One stray CRLF does not turn a whole LF file into CRLF, and a byte order mark never lands in a body.
		expect(parseCloudSkillFile("---\nname: a\r\ndescription: b\n---\nx\n").newline).toBe("\n");
		expect(parseCloudSkillFile("\uFEFF# Steps\n").body).toBe("# Steps\n");
	});
});
