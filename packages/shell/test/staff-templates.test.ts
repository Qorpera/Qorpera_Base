import { existsSync, readFileSync, statSync } from "node:fs";
import {
	isStaffCharacterId,
	STAFF_CHARACTER_BY_TEMPLATE,
	STAFF_CHARACTER_IDS,
} from "@qorpera/cloud-client/staff-characters";
import { STAFF_TEMPLATE_IDS } from "@qorpera/cloud-client/staff-template-ids";
import { describe, expect, it } from "vitest";
import { getStaffTemplate, listStaffTemplates, type StaffTemplate } from "../src/staff-templates.ts";

const EXPECTED_ROLES = [
	["agent-manager", "Agent Manager"],
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
	it("provides the founder-selected roles in a stable order", () => {
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
			expect(template.setupPrompt).toContain("No dedicated artifact is created");
			expect(template.setupPrompt).toContain("live Company File");
			expect(template.setupPrompt).toContain("artifact is not a setup requirement");
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
			expect(template.setupPrompt).not.toContain("starter artifact");
			expect(template.starterArtifact.title.length).toBeGreaterThan(0);
			expect(template.starterArtifact.purpose.length).toBeGreaterThan(0);
			expect(template.starterArtifact.metrics).toHaveLength(3);
			expect(template.starterArtifact.dataNeeds.length).toBeGreaterThan(0);
			expect(template.starterArtifact.dataNeeds.every((need) => need.connectorHints.length > 0)).toBe(true);
			expect(template.avatarColorToken).toMatch(/^qorpera-[a-z]+$/);
			expect(template.avatarShapeToken).toMatch(/^[a-z][a-z-]*$/);
		}
	});

	it("does not instantiate template artifacts during agent creation", () => {
		const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
		expect(main).not.toContain("createStarterCompanyArtifact");
		expect(main).toContain("No dedicated artifact was seeded for this agent");
	});

	it("ships a static asset for every approved character", () => {
		expect(STAFF_CHARACTER_IDS).not.toContain("lantern");
		expect(existsSync(new URL("../userland/staff-creatures/lantern.png", import.meta.url))).toBe(false);
		for (const characterId of STAFF_CHARACTER_IDS) {
			const asset = new URL(`../userland/staff-creatures/${characterId}.png`, import.meta.url);
			expect(existsSync(asset)).toBe(true);
			expect(statSync(asset).size).toBeGreaterThan(10_000);
			const png = readFileSync(asset);
			expect(png.subarray(1, 4).toString("ascii")).toBe("PNG");
			expect(png[25]).toBe(6);
		}
	});

	it("loads the creature motion layer with integrated eyes and activity states", () => {
		const index = readFileSync(new URL("../userland/index.html", import.meta.url), "utf8");
		const motion = readFileSync(new URL("../userland/character-motion.css", import.meta.url), "utf8");
		const colors = readFileSync(new URL("../userland/staff-creature-colors.svg", import.meta.url), "utf8");
		const renderer = readFileSync(new URL("../userland/renderer.js", import.meta.url), "utf8");
		expect(index).toContain('<link rel="stylesheet" href="./character-motion.css">');
		expect(motion).toContain(".staff-avatar > .staff-face i");
		expect(motion).toContain("@keyframes creature-eye-one-blink");
		expect(motion).toContain("@keyframes creature-working");
		expect(motion).toContain("@keyframes creature-writing");
		expect(motion).toContain("@keyframes creature-writing-dots");
		expect(motion).toContain("@keyframes creature-writing-eye-one");
		expect(motion).toContain("@keyframes creature-writing-eye-two");
		expect(motion).toContain(".staff-avatar::before {");
		expect(motion).toContain(".staff-avatar::after {");
		expect(motion).toContain(".staff-avatar.writing::before");
		expect(motion).toContain(".staff-avatar.writing::after");
		expect(motion).not.toContain("creature-writing-cloud");
		expect(motion).not.toContain("creature-writing-dots-visibility");
		expect(motion).not.toContain("creature-writing-marks");
		expect(motion).toContain("@keyframes creature-attention");
		expect(motion).toContain(".staff-avatar.writing");
		expect(motion).toContain(".staff-avatar.needs-attention");
		expect(motion).toContain('.staff-avatar[data-creature="folio"]');
		expect(motion).toContain('.staff-avatar[data-creature="folio"].working > .staff-creature-image');
		expect(motion).toContain('.staff-avatar[data-creature="folio"].working::before');
		expect(motion).toContain('.staff-avatar[data-creature="folio"].working::after');
		expect(motion).toContain('.staff-avatar[data-creature="folio"].stowing');
		expect(motion).toContain("@keyframes folio-page-enter");
		expect(motion).toContain("@keyframes folio-read-scan");
		expect(motion).not.toMatch(/data-creature="folio"\]\.(?:writing|needs-attention)/);
		expect(motion).not.toMatch(/data-creature="folio"\]\s*>\s*\.staff-creature-image/);
		expect(motion).not.toContain("lantern");
		expect(motion).toContain('--staff-creature-filter: url("#staff-color-cobalt") !important;');
		expect(motion).toContain(".staff-appearance-picker .staff-color-picker");
		expect(colors.match(/<filter id=/g)).toHaveLength(12);
		expect(colors).toContain('flood-color="#ff365e"');
		expect(colors).toContain('flood-color="#0071e3"');
		expect(renderer).toContain('const STAFF_MOTION_STATES = ["idle", "working", "writing", "needs-attention"];');
		expect(renderer).toContain('folio: Object.freeze({ label: "Folio", asset: "./staff-creatures/folio.png" })');
		expect(renderer).not.toContain("lantern");
		expect(renderer).toContain('if (staffNeedsAttention(staff, runtime)) return "needs-attention";');
		expect(renderer).toContain('runtime.activity?.kind === "writing"');
		expect(renderer).toContain("function setAvatarMotionState(avatar, status, actualStatus = status)");
		expect(renderer).toContain("staffWorkElapsed(avatar.dataset.staffId, motion, actualMotion)");
		expect(renderer).toContain('if (motion !== actualMotion) return "0ms";');
		expect(renderer).toContain(
			"const actualStatus = staffId(staffOrTemplate) ? staffStatus(staffOrTemplate) : status;",
		);
		expect(renderer).not.toContain('showThreadActivity("typing")');
		expect(renderer).not.toContain('showThreadActivity("thinking")');
	});

	it("keeps creature color filters document-local for stable roster paints", () => {
		const index = readFileSync(new URL("../userland/index.html", import.meta.url), "utf8");
		const motion = readFileSync(new URL("../userland/character-motion.css", import.meta.url), "utf8");
		const colors = readFileSync(new URL("../userland/staff-creature-colors.svg", import.meta.url), "utf8");
		const inlinePalette = Object.fromEntries(
			[...index.matchAll(/<filter id="staff-color-([^"]+)"[^>]*>[\s\S]*?<feFlood flood-color="([^"]+)"/g)].map(
				([, id, color]) => [id, color],
			),
		);
		const assetPalette = Object.fromEntries(
			[...colors.matchAll(/<filter id="([^"]+)"[^>]*>[\s\S]*?<feFlood flood-color="([^"]+)"/g)].map(
				([, id, color]) => [id, color],
			),
		);
		expect(Object.keys(inlinePalette)).toHaveLength(12);
		expect(inlinePalette).toEqual(assetPalette);
		expect(index.indexOf('id="staff-color-charcoal"')).toBeLessThan(index.indexOf('<header id="titlebar">'));
		expect(motion).toContain("filter: var(--staff-creature-filter, none) !important;");
		expect(motion).not.toContain('url("./staff-creature-colors.svg#');
		expect(motion).toMatch(
			/@media \(forced-colors: active\) \{[\s\S]*?\.staff-avatar\[style\*="--staff-color:"\] \{\s*--staff-creature-filter: none !important;\s*\}[\s\S]*?\.staff-avatar\[style\*="--staff-color:"\] > \.staff-creature-image \{\s*filter: none !important;/,
		);
	});

	it("keeps character identity independent from suggested role identity", () => {
		expect(new Set(Object.values(STAFF_CHARACTER_BY_TEMPLATE))).toEqual(new Set(STAFF_CHARACTER_IDS));
		expect(STAFF_CHARACTER_BY_TEMPLATE["agent-manager"]).toBe("brain");
		expect(STAFF_CHARACTER_BY_TEMPLATE["operations-specialist"]).toBe("pebble");
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
