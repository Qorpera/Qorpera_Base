import { describe, expect, it } from "vitest";
import {
	appGroupNameFromAnswer,
	LIGHT_ASK_SCHEMA,
	NAME_APP_GROUP,
	nameAppGroupInput,
	parseLightAsk,
} from "../src/cloud/light-asks.ts";

/* Light asks (deploy/first-node/RUNTIME-LIGHT-ASK.md, migration 20260930761000): the cloud's answer as the web reads
 * it, and the first kind's input as the cloud takes it. */

const ASK = {
	schema: LIGHT_ASK_SCHEMA,
	id: "12580000-0000-4000-8000-0000000000a1",
	kind: NAME_APP_GROUP,
	state: "waiting",
	answer: null,
	problem: null,
};

describe("a light ask as the cloud answers it", () => {
	it("reads a waiting, an answered and a failed ask", () => {
		expect(parseLightAsk(ASK)).toEqual({
			id: ASK.id,
			kind: "name-app-group",
			state: "waiting",
			answer: null,
			problem: null,
		});
		expect(parseLightAsk({ ...ASK, state: "answered", answer: "Money" })).toMatchObject({
			state: "answered",
			answer: "Money",
		});
		expect(parseLightAsk({ ...ASK, state: "failed", problem: "no_payer" })).toMatchObject({
			state: "failed",
			problem: "no_payer",
		});
	});

	it.each<[string, unknown]>([
		["nothing", null],
		["a list", [ASK]],
		["another schema", { ...ASK, schema: "qorpera.light-ask/v2" }],
		["no id", { ...ASK, id: undefined }],
		["an id that is no id", { ...ASK, id: "one" }],
		["a state it does not know", { ...ASK, state: "done" }],
		["an answered ask with no answer", { ...ASK, state: "answered" }],
		["an answered ask with an empty answer", { ...ASK, state: "answered", answer: "" }],
		["a waiting ask with an answer", { ...ASK, answer: "Money" }],
		["an answer that is no text", { ...ASK, state: "answered", answer: 7 }],
	])("refuses %s", (_label, value) => {
		expect(() => parseLightAsk(value)).toThrow();
	});
});

describe("the name of a new group of apps", () => {
	it("makes the input the cloud takes: each app's name and, when it has one, a line about it", () => {
		expect(
			nameAppGroupInput(
				[
					{ name: " Bank " },
					{ name: "Company   finances", about: "What we earn\nand spend." },
					{ name: "Plan", about: null },
				],
				"da",
			),
		).toEqual({
			apps: [{ name: "Bank" }, { name: "Company finances", about: "What we earn and spend." }, { name: "Plan" }],
			language: "da",
		});
		// A long name and a long line are cut to what the cloud takes.
		const cut = nameAppGroupInput([{ name: "n".repeat(100) }, { name: "B", about: "a".repeat(300) }], "en")!;
		expect(cut.apps[0]?.name).toHaveLength(80);
		expect(cut.apps[1]?.about).toHaveLength(200);
		// At most twelve apps.
		expect(
			nameAppGroupInput(
				Array.from({ length: 20 }, (_, n) => ({ name: `App ${n}` })),
				"en",
			)!.apps,
		).toHaveLength(12);
	});

	it("leaves out what the cloud would refuse: a control character, and the lines about apps when they are too much", () => {
		// A C1 control is one to the cloud too.
		expect(nameAppGroupInput([{ name: "Ba\u0085nk" }, { name: "Plan\u2028B" }], "en")!.apps).toEqual([
			{ name: "Ba nk" },
			{ name: "Plan B" },
		]);
		// Twelve apps with long lines in three-byte letters pass the cloud's size: the names alone are sent.
		const long = Array.from({ length: 12 }, (_, n) => ({ name: `App ${n}`, about: "\u65e5".repeat(200) }));
		const names = nameAppGroupInput(long, "da")!;
		expect(names.apps).toEqual(long.map(({ name }) => ({ name })));
		expect(new TextEncoder().encode(JSON.stringify(names)).length).toBeLessThanOrEqual(3_000);
		// With short lines they stay.
		expect(
			nameAppGroupInput(
				long.map(({ name }) => ({ name, about: "Short." })),
				"da",
			)!.apps[0],
		).toEqual({
			name: "App 0",
			about: "Short.",
		});
		// Names alone too large make no input.
		expect(
			nameAppGroupInput(
				Array.from({ length: 12 }, () => ({ name: "\u65e5".repeat(80) })),
				"da",
			),
		).toBeUndefined();
	});

	it("makes no input of fewer than two apps, or of an app with no name", () => {
		expect(nameAppGroupInput([], "en")).toBeUndefined();
		expect(nameAppGroupInput([{ name: "Bank" }], "en")).toBeUndefined();
		expect(nameAppGroupInput([{ name: "Bank" }, { name: "   " }], "en")).toBeUndefined();
	});

	it("takes an answer as a name of one line and at most 40 characters", () => {
		expect(appGroupNameFromAnswer("Money")).toBe("Money");
		expect(appGroupNameFromAnswer("  Money \n matters ")).toBe("Money matters");
		expect(appGroupNameFromAnswer("n".repeat(40))).toBe("n".repeat(40));
		expect(appGroupNameFromAnswer("n".repeat(41))).toBeUndefined();
		expect(appGroupNameFromAnswer("   ")).toBeUndefined();
		expect(appGroupNameFromAnswer(null)).toBeUndefined();
	});
});
