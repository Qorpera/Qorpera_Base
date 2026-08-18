import { existsSync, readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isStaffCharacterId, STAFF_CHARACTER_BY_TEMPLATE, STAFF_CHARACTER_IDS } from "../src/staff-characters.ts";
import {
	getStaffTemplate,
	listStaffTemplates,
	STAFF_TEMPLATE_IDS,
	type StaffTemplate,
} from "../src/staff-templates.ts";

const EXPECTED_ROLES = [
	["financial-officer", "Financial Officer"],
	["marketing-lead", "Marketing Lead"],
	["product-manager", "Product Manager"],
	["software-developer", "Software Developer"],
	["product-designer", "Product Designer"],
	["legal-expert", "Legal Expert"],
	["operations-specialist", "Operations Specialist"],
	["research-lead", "Research Lead"],
	["costumer-relationist", "Costumer Relationist"],
	["outreaching-conversationalist", "Outreaching Conversationalist"],
] as const;
describe("shell starter staff templates", () => {
	it("provides the ten founder-selected roles in a stable order", () => {
		const templates = listStaffTemplates();
		expect(templates.map(({ id, name }) => [id, name])).toEqual(EXPECTED_ROLES);
		expect(STAFF_TEMPLATE_IDS).toEqual(EXPECTED_ROLES.map(([id]) => id));
		expect(new Set(templates.map(({ id }) => id)).size).toBe(templates.length);
		expect(JSON.stringify(templates).toLowerCase()).not.toContain("grok");
	});

	it("keeps durable responsibility separate from setup behavior", () => {
		for (const template of listStaffTemplates()) {
			expect(template.role.length).toBeGreaterThan(0);
			expect(template.description.length).toBeGreaterThan(0);
			expect(template.charter).toContain("durable company responsibility");
			expect(template.charter).toContain("already-ready connectors");
			expect(template.charter).toContain("ready company mailbox");
			expect(template.charter).toContain("not automatically as the authoritative source");
			expect(template.charter).toContain("ask one plain question");
			expect(template.charter).toContain("never guess a provider list");
			expect(template.charter).toContain("offer only Gmail or Outlook Email");
			expect(template.charter).toContain("leave the evidence gap explicit");
			expect(template.charter).toContain("Continue source discovery after conception");
			expect(template.charter).not.toContain("On the first turn");
			expect(template.charter).not.toContain("During setup");
			expect(template.setupPrompt).toContain("private conception turn");
			expect(template.setupPrompt).toContain("employment relationship");
			expect(template.setupPrompt).toContain("Existing company evidence takes priority");
			expect(template.setupPrompt).toContain("test already-ready read connections");
			expect(template.setupPrompt).toContain("Trace concrete service and account names");
			expect(template.setupPrompt).toContain("search it narrowly");
			expect(template.setupPrompt).toContain("ask one brief ordinary-language question");
			expect(template.setupPrompt).toContain("Gmail or Outlook Email discovery connection");
			expect(template.setupPrompt).toContain("without artifactId or dataNeedId");
			expect(template.setupPrompt).toContain("never convert that uncertainty into guessed providers");
			expect(template.setupPrompt).toContain("offer only a separate Gmail or Outlook Email");
			expect(template.setupPrompt).toContain("call request_connection exactly once");
			expect(template.setupPrompt).toContain("exact setup contract");
			expect(template.setupPrompt).toContain("Never silently replace it with a public export");
			expect(template.setupPrompt).toContain("Choose where I should look first below.");
			expect(template.setupPrompt).toContain("Never say that access was requested");
			expect(template.setupPrompt).toContain("propose one concrete recurring job and cadence");
			expect(template.setupPrompt).toContain(template.starterArtifact.title);
			expect(template.starterArtifact.title.length).toBeGreaterThan(0);
			expect(template.starterArtifact.purpose.length).toBeGreaterThan(0);
			expect(template.starterArtifact.metrics).toHaveLength(3);
			expect(template.starterArtifact.dataNeeds.length).toBeGreaterThan(0);
			expect(template.starterArtifact.dataNeeds.every((need) => need.connectorHints.length > 0)).toBe(true);
			expect(template.avatarColorToken).toMatch(/^qorpera-[a-z]+$/);
			expect(template.avatarShapeToken).toMatch(/^[a-z][a-z-]*$/);
		}
	});

	it("ships a static asset for every approved character", () => {
		for (const characterId of STAFF_CHARACTER_IDS) {
			const asset = new URL(`../userland/staff-creatures/${characterId}.png`, import.meta.url);
			expect(existsSync(asset)).toBe(true);
			expect(statSync(asset).size).toBeGreaterThan(10_000);
		}
	});

	it("loads the creature motion layer with integrated eyes and activity states", () => {
		const index = readFileSync(new URL("../userland/index.html", import.meta.url), "utf8");
		const motion = readFileSync(new URL("../userland/character-motion.css", import.meta.url), "utf8");
		const renderer = readFileSync(new URL("../userland/renderer.js", import.meta.url), "utf8");
		expect(index).toContain('<link rel="stylesheet" href="./character-motion.css">');
		expect(motion).toContain(".staff-avatar > .staff-face i");
		expect(motion).toContain("@keyframes creature-eye-one-blink");
		expect(motion).toContain("@keyframes creature-working");
		expect(motion).toContain("@keyframes creature-writing");
		expect(motion).toContain("@keyframes creature-attention");
		expect(motion).toContain(".staff-avatar.writing");
		expect(motion).toContain(".staff-avatar.needs-attention");
		expect(motion).toContain('.staff-avatar[data-creature="folio"]');
		expect(renderer).toContain('const STAFF_MOTION_STATES = ["idle", "working", "writing", "needs-attention"];');
		expect(renderer).toContain('folio: Object.freeze({ label: "Folio", asset: "./staff-creatures/folio.png" })');
		expect(renderer).toContain('if (staffNeedsAttention(staff, runtime)) return "needs-attention";');
		expect(renderer).toContain('runtime.activity?.kind === "writing"');
		expect(renderer).not.toContain('showThreadActivity("typing")');
		expect(renderer).not.toContain('showThreadActivity("thinking")');
	});

	it("keeps character identity independent from suggested role identity", () => {
		expect(new Set(Object.values(STAFF_CHARACTER_BY_TEMPLATE))).toEqual(new Set(STAFF_CHARACTER_IDS));
		expect(STAFF_CHARACTER_BY_TEMPLATE["product-manager"]).toBe("folio");
		expect(STAFF_CHARACTER_IDS.every(isStaffCharacterId)).toBe(true);
		expect(STAFF_CHARACTER_IDS.some((characterId) => new Set<string>(STAFF_TEMPLATE_IDS).has(characterId))).toBe(
			false,
		);
	});

	it("looks up strictly and returns deep-frozen copy-safe values", () => {
		const first = getStaffTemplate("financial-officer");
		const second = getStaffTemplate("financial-officer");
		expect(first).toEqual(second);
		expect(first).not.toBe(second);
		expect(Object.isFrozen(first)).toBe(true);
		expect(typeof first.setupPrompt).toBe("string");
		expect(Object.isFrozen(first.starterArtifact)).toBe(true);
		expect(Object.isFrozen(first.starterArtifact.metrics)).toBe(true);
		expect(first.starterArtifact.metrics.every((metric) => Object.isFrozen(metric))).toBe(true);
		expect(Reflect.set(first, "name", "Changed")).toBe(false);
		expect(getStaffTemplate("financial-officer")).toEqual(second);
		expect(() => getStaffTemplate("operations")).toThrow("Unknown staff template: operations");
		expect(() => getStaffTemplate("")).toThrow("Unknown staff template");
	});

	it("returns a fresh immutable catalog and immutable entries", () => {
		const first = listStaffTemplates();
		const second = listStaffTemplates();
		expect(first).not.toBe(second);
		expect(first[0]).not.toBe(second[0]);
		expect(Object.isFrozen(first)).toBe(true);
		expect(first.every((template: StaffTemplate) => Object.isFrozen(template))).toBe(true);
		expect(Reflect.set(first, "0", getStaffTemplate("research-lead"))).toBe(false);
		expect(listStaffTemplates().map(({ id }) => id)).toEqual(STAFF_TEMPLATE_IDS);
	});
});
