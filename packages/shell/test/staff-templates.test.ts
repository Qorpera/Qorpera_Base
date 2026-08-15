import { describe, expect, it } from "vitest";
import {
	getStaffTemplate,
	listStaffTemplates,
	STAFF_TEMPLATE_IDS,
	type StaffTemplate,
} from "../src/staff-templates.ts";

const EXPECTED_ROLES = [
	["operations-lead", "Operations Lead"],
	["research-lead", "Research Lead"],
	["inbox-steward", "Inbox Steward"],
	["finance-partner", "Finance Partner"],
	["product-builder", "Product Builder"],
	["customer-advocate", "Customer Advocate"],
] as const;

describe("shell starter staff templates", () => {
	it("provides the six original roles in a stable order", () => {
		const templates = listStaffTemplates();
		expect(templates.map(({ id, name }) => [id, name])).toEqual(EXPECTED_ROLES);
		expect(STAFF_TEMPLATE_IDS).toEqual(EXPECTED_ROLES.map(([id]) => id));
		expect(new Set(templates.map(({ id }) => id)).size).toBe(templates.length);
		expect(JSON.stringify(templates).toLowerCase()).not.toContain("grok");
	});

	it("carries first-turn behavior, Qorpera avatar tokens, and generic connection metadata", () => {
		for (const template of listStaffTemplates()) {
			expect(template.role.length).toBeGreaterThan(0);
			expect(template.description.length).toBeGreaterThan(0);
			expect(template.charter).toContain("On the first turn");
			expect(template.charter).toContain("propose one useful outcome");
			expect(template.charter).toContain("ask at most one high-value question");
			expect(template.charter).toContain("Honestly name any missing");
			expect(template.avatarColorToken).toMatch(/^qorpera-[a-z]+$/);
			expect(template.avatarShapeToken).toMatch(/^[a-z][a-z-]*$/);
			expect(template.suggestedConnectionIds.length).toBeGreaterThan(0);
			for (const connectionId of template.suggestedConnectionIds) {
				expect(connectionId).toMatch(/^[a-z][a-z-]*$/);
			}
		}
	});

	it("looks up strictly and returns deep-frozen copy-safe values", () => {
		const first = getStaffTemplate("operations-lead");
		const second = getStaffTemplate("operations-lead");
		expect(first).toEqual(second);
		expect(first).not.toBe(second);
		expect(first.suggestedConnectionIds).not.toBe(second.suggestedConnectionIds);
		expect(Object.isFrozen(first)).toBe(true);
		expect(Object.isFrozen(first.suggestedConnectionIds)).toBe(true);
		expect(Reflect.set(first, "name", "Changed")).toBe(false);
		expect(Reflect.set(first.suggestedConnectionIds, "0", "changed")).toBe(false);
		expect(getStaffTemplate("operations-lead")).toEqual(second);
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
