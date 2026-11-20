import { parseCloudAgentSendInput } from "@qorpera/runtime/cloud-agent-mouth";
import { CloudToolArgumentRefusal } from "@qorpera/runtime/cloud-native-tool-boundary";
import {
	CLOUD_ASK_MEMBER_INPUT_SCHEMA,
	CLOUD_ASK_MEMBER_INSTRUCTIONS,
	CLOUD_ASK_MEMBER_PAYLOAD_SCHEMA,
	CLOUD_ASK_MEMBER_SURFACES,
	CLOUD_INTERACTION_PAYLOAD_SCHEMA,
	CLOUD_INTERACTION_SURFACES,
	cloudAskMemberFinalKey,
	cloudInteractionEventId,
	parseCloudAskMemberInput,
	parseCloudInteractionRequestData,
} from "@qorpera/runtime/cloud-thread-interactions";
import { describe, expect, it } from "vitest";

const RUN = "33333333-3333-4333-8333-333333333333";

describe("thread interaction requests", () => {
	it("accepts a secret card that names its connector and refuses names outside the custody pattern", () => {
		const secret = {
			schema: "qorpera.interaction/v1",
			surface: "secret",
			title: "Connect Linear",
			payload: { name: "api-key", label: "Linear API key", purpose: "Filing issues.", connectorId: "linear" },
		};
		expect(parseCloudInteractionRequestData(secret).payload).toEqual(secret.payload);
		expect(() =>
			parseCloudInteractionRequestData({ ...secret, payload: { ...secret.payload, name: "1bad" } }),
		).toThrow(/Invalid interaction request/);
		expect(() =>
			parseCloudInteractionRequestData({ ...secret, payload: { ...secret.payload, connectorId: "Slack!" } }),
		).toThrow(/Invalid interaction request/);
		expect(() =>
			parseCloudInteractionRequestData({ ...secret, payload: { ...secret.payload, value: "xoxb-secret" } }),
		).toThrow(/Invalid interaction request/);
	});

	it("accepts a coding value's card with its repository, and refuses a repository anywhere else", () => {
		const card = (payload: Record<string, unknown>) => ({
			schema: "qorpera.interaction/v1",
			surface: "secret",
			title: "Token for private packages",
			payload: {
				name: "npm_token",
				label: "NPM_TOKEN",
				purpose: "Installs the private packages.",
				connectorId: "environment",
				...payload,
			},
		});
		expect(parseCloudInteractionRequestData(card({ repository: "acme/web" })).payload).toMatchObject({
			connectorId: "environment",
			repository: "acme/web",
		});
		// Without a repository it is still a coding value: a member's own reaches their sessions in every repository.
		expect(parseCloudInteractionRequestData(card({})).payload).not.toHaveProperty("repository");
		for (const payload of [
			// Only lower-case owner/name.
			{ repository: "Acme/Web" },
			{ repository: "acme" },
			{ repository: "acme/web/extra" },
			// A repository only beside the environment connector.
			{ connectorId: "linear", repository: "acme/web" },
			// A coding value's name as the capture takes it.
			{ name: "npm-token" },
			{ name: "git_token" },
			{ name: "openai_api_key" },
			// The names a coding machine sets itself, as the kernel lists them.
			{ name: "path" },
			{ name: "https_proxy" },
			{ name: "node_extra_ca_certs" },
			{ name: "home" },
		])
			expect(() => parseCloudInteractionRequestData(card(payload))).toThrow(/Invalid interaction request/);
		const plain = card({ connectorId: undefined, repository: "acme/web" });
		delete (plain.payload as Record<string, unknown>).connectorId;
		expect(() => parseCloudInteractionRequestData(plain)).toThrow(/Invalid interaction request/);
	});

	it("keeps the same card id for a retried ask", () => {
		const input = parseCloudAskMemberInput({
			idempotencyKey: "slack",
			text: "I need a token.",
			surface: "secret",
			title: "Connect Slack",
			payload: { name: "bot-token", label: "Slack bot token", purpose: "Posting.", connectorId: "slack" },
		});
		expect(input.data.surface).toBe("secret");
		expect(cloudInteractionEventId(RUN, "slack")).toBe(cloudInteractionEventId(RUN, "slack"));
		expect(cloudInteractionEventId(RUN, "slack")).not.toBe(cloudInteractionEventId(RUN, "slack-2"));
		expect(cloudInteractionEventId(RUN, "slack")).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/,
		);
	});
	it("derives a final-send key the send accepts for every key ask_member accepts", () => {
		const card = {
			text: "Pick one.",
			surface: "question",
			title: "Decision",
			payload: { options: [{ label: "Yes" }] },
		};
		const keys = [1, 121, 122, 123, 127, 128].map((length) => "k".repeat(length));
		for (const key of keys) {
			const accepted = parseCloudAskMemberInput({ idempotencyKey: key, ...card }).idempotencyKey;
			const finalKey = cloudAskMemberFinalKey(accepted);
			expect(
				parseCloudAgentSendInput({ idempotencyKey: finalKey, text: card.text, phase: "final" }).idempotencyKey,
			).toBe(finalKey);
			// Deterministic, so a retry of the same card replays the same send.
			expect(cloudAskMemberFinalKey(accepted)).toBe(finalKey);
		}
		// Keys that fit keep the readable suffix; longer ones become their digest.
		expect(cloudAskMemberFinalKey("channel")).toBe("channel:final");
		expect(cloudAskMemberFinalKey("k".repeat(122))).toBe(`${"k".repeat(122)}:final`);
		expect(cloudAskMemberFinalKey("k".repeat(123))).toMatch(/^ask-final\.[0-9a-f]{64}$/);
		expect(new Set(keys.map(cloudAskMemberFinalKey)).size).toBe(keys.length);
		expect(cloudAskMemberFinalKey(`${"k".repeat(127)}a`)).not.toBe(cloudAskMemberFinalKey(`${"k".repeat(127)}b`));
	});
	it("refuses a card sentence its final send could not carry, before anything is appended", () => {
		const card = {
			idempotencyKey: "k",
			surface: "question",
			title: "Decision",
			payload: { options: [{ label: "Yes" }] },
		};
		expect(() => parseCloudAskMemberInput({ ...card, text: "Pick\u0000one." })).toThrow(CloudToolArgumentRefusal);
		expect(() => parseCloudAskMemberInput({ ...card, text: "Pick one.", title: "Deci\u0000sion" })).toThrow(
			CloudToolArgumentRefusal,
		);
	});
});

type Schema = { [key: string]: unknown };

/** Every property path a schema offers, down through objects and arrays of objects. */
function schemaPaths(schema: Schema, prefix = ""): string[] {
	const node = schema.type === "array" ? (schema.items as Schema) : schema;
	if (node.type !== "object") return [];
	return Object.entries(node.properties as Record<string, Schema>).flatMap(([key, child]) => [
		`${prefix}${key}`,
		...schemaPaths(child, `${prefix}${key}.`),
	]);
}
/** Every property path an example uses, across all elements of its arrays. */
function valuePaths(value: unknown, prefix = ""): string[] {
	if (Array.isArray(value)) return value.flatMap((item) => valuePaths(item, prefix));
	if (!value || typeof value !== "object") return [];
	return Object.entries(value).flatMap(([key, child]) => [
		`${prefix}${key}`,
		...valuePaths(child, `${prefix}${key}.`),
	]);
}

// For each surface: only what its schema requires, and everything its schema offers.
const PAYLOADS = {
	question: {
		minimal: { options: [{ label: "Apples" }] },
		maximal: {
			options: [
				{ label: "apples", value: "apples", description: "Crisp.", style: "primary", preview: "fruit/apples.svg" },
			],
			multiSelect: false,
			allowCustom: true,
			dismissOnMoveOn: false,
			input: { kind: "mail_address" },
			asksAgain: "5a1e9f04-7c2b-4d3e-a1b2-0123456789ab",
		},
	},
	secret: {
		minimal: { name: "api-key", label: "API key", purpose: "Filing issues." },
		maximal: {
			name: "npm_token",
			label: "NPM_TOKEN",
			purpose: "Installs the private packages.",
			kind: "token",
			connectorId: "environment",
			repository: "acme/web",
		},
	},
	form: {
		minimal: { domain: "app.example.com", fields: [{ id: "email", label: "Email", type: "email" }] },
		maximal: {
			domain: "app.example.com",
			reason: "sign_in",
			submitAfterFill: false,
			fields: [
				{
					id: "password",
					label: "Password",
					type: "password",
					required: true,
					placeholder: "",
					secret: true,
					target: { kind: "ref", value: "e12" },
					vaultName: "example-password",
				},
				{ id: "plan", label: "Plan", type: "select", options: [{ label: "Pro", value: "pro" }] },
			],
		},
	},
	takeover: {
		minimal: { instruction: "Sign in, then press I'm done." },
		maximal: {
			instruction: "Sign in, then press I'm done.",
			reason: "sign_in",
			domain: "app.example.com",
			idpDomain: "accounts.example.com",
		},
	},
	draft: {
		minimal: { platform: "email", connectorId: "gmail", from: "a@example.com", to: ["b@example.com"], body: "Hi." },
		maximal: {
			platform: "email",
			connectorId: "gmail",
			from: "a@example.com",
			to: ["b@example.com"],
			cc: ["c@example.com"],
			subject: "Hello",
			body: "Hi.",
			replyTo: "message-1",
			threadRef: "thread-1",
		},
	},
	credential: {
		minimal: { name: "example", domain: "app.example.com" },
		maximal: { name: "example", domain: "app.example.com", purpose: "Signing in." },
	},
} as const;

/** The first object at a dotted path, entering the first array element that has the next key. */
function holder(root: unknown, path: string[]): Record<string, unknown> | undefined {
	let node: unknown = root;
	for (const key of path) {
		const candidates: unknown[] = Array.isArray(node) ? node : [node];
		const next = candidates.find(
			(item): item is Record<string, unknown> => !!item && typeof item === "object" && key in item,
		);
		if (!next) return undefined;
		node = next[key];
	}
	const candidates: unknown[] = Array.isArray(node) ? node : [node];
	return candidates.find((item): item is Record<string, unknown> => !!item && typeof item === "object");
}

/** Edge cases from a schema, applied to a valid example one change at a time. */
function constraintChecks(schema: Schema, example: unknown, surface: string) {
	const checks: { name: string; payload: unknown; accepted: boolean }[] = [];
	const change = (
		name: string,
		path: string[],
		key: string,
		update: (target: Record<string, unknown>) => void,
		accepted: boolean,
	) => {
		const payload = structuredClone(example) as Record<string, unknown>;
		const target = holder(payload, path);
		if (!target || !(key in target)) return;
		update(target);
		checks.push({ name, payload, accepted });
	};
	const walk = (node: Schema, path: string[]) => {
		const object = node.type === "array" ? (node.items as Schema) : node;
		if (object.type !== "object") return;
		for (const [key, child] of Object.entries(object.properties as Record<string, Schema>)) {
			const at = [...path, key].join(".");
			const string = child.type === "array" ? (child.items as Schema) : child;
			const wrap = (value: string) => (child.type === "array" ? [value] : value);
			if (typeof string.minLength === "number" && (string.minLength as number) > 0) {
				const min = string.minLength as number;
				change(
					`${at} at ${min}`,
					path,
					key,
					(target) => {
						target[key] = wrap("a".repeat(min));
					},
					true,
				);
				change(
					`${at} under ${min}`,
					path,
					key,
					(target) => {
						target[key] = wrap("a".repeat(min - 1));
					},
					false,
				);
			}
			if (typeof string.pattern === "string")
				change(
					`${at} off its pattern`,
					path,
					key,
					(target) => {
						target[key] = wrap("Not A Match!");
					},
					false,
				);
			if (child.type === "array") {
				// Distinct copies of the first item, so that unique form field ids stay unique.
				const copies = (count: number) => (target: Record<string, unknown>) => {
					const first = (target[key] as unknown[])[0];
					target[key] = Array.from({ length: count }, (_, index) =>
						first && typeof first === "object" && "id" in first
							? { ...first, id: `f${index}` }
							: structuredClone(first),
					);
				};
				for (const [bound, delta, accepted] of [
					["minItems", 0, true],
					["minItems", -1, false],
					["maxItems", 0, true],
					["maxItems", 1, false],
				] as const) {
					const limit = child[bound] as number | undefined;
					if (typeof limit === "number" && limit + delta >= 0)
						change(`${at} with ${limit + delta} items`, path, key, copies(limit + delta), accepted);
				}
			}
			if (typeof string.maxLength === "number") {
				const max = string.maxLength as number;
				change(
					`${at} at ${max}`,
					path,
					key,
					(target) => {
						target[key] = wrap("a".repeat(max));
					},
					true,
				);
				change(
					`${at} over ${max}`,
					path,
					key,
					(target) => {
						target[key] = wrap("a".repeat(max + 1));
					},
					false,
				);
			}
			// A field's type is also bound to its options and target: the examples cover that.
			if (Array.isArray(child.enum) && !(surface === "form" && at === "fields.type"))
				for (const value of child.enum as string[])
					change(
						`${at} = ${value}`,
						path,
						key,
						(target) => {
							target[key] = value;
						},
						true,
					);
			if ((object.required as string[]).includes(key))
				change(`${at} missing`, path, key, (target) => delete target[key], false);
			walk(child, [...path, key]);
		}
	};
	walk(schema, []);
	return checks;
}

const ask = (surface: string, payload: unknown) => ({
	idempotencyKey: "card",
	text: "One thing first.",
	surface,
	title: "A decision",
	payload,
});

describe("readable cards", () => {
	const card = (body: string, label = "Approve") => ({
		idempotencyKey: "vision",
		text: "Here is the draft.",
		surface: "question",
		title: "Approve the draft vision?",
		body,
		payload: { options: [{ label, style: "primary" }, { label: "Change it" }] },
	});
	const refused = (value: unknown, words: string) => {
		expect(() => parseCloudAskMemberInput(value)).toThrow(CloudToolArgumentRefusal);
		expect(() => parseCloudAskMemberInput(value)).toThrow(words);
	};

	it("takes a picture per option for a visual choice, and refuses one that is no image or app", () => {
		const visual = (preview: string) => ({
			...card("Two looks, same price."),
			payload: {
				options: [
					{ label: "Colour Duo", preview },
					{ label: "Matching Pair", preview: "app:pair-demo" },
				],
			},
		});
		expect(parseCloudAskMemberInput(visual("sketches/duo.svg")).data.payload).toEqual({
			options: [
				{ label: "Colour Duo", preview: "sketches/duo.svg" },
				{ label: "Matching Pair", preview: "app:pair-demo" },
			],
		});
		for (const bad of [
			"sketches/duo.md",
			"https://example.com/a.png",
			"/abs/a.png",
			"a/../b.png",
			"app:Bad Name",
			"app:a--b",
			"app:abc-",
		])
			refused(visual(bad), "an option's preview is the company file path of an image you made for it");
		expect(JSON.stringify(CLOUD_ASK_MEMBER_PAYLOAD_SCHEMA)).toContain("Options with pictures show as big boxes");
	});

	// Jonas, 14 Nov 2026, on Type privately in the computer window: "Yes, remove it". Nothing in the web begins a private
	// hold of an agent's computer any more (#1812): a member who signs in for an agent does it on the screen the agent and
	// the other members share. The agent was told its calls are refused meanwhile and could have passed that on as
	// privacy; it is told what is true, and still to end its turn until I'm done wakes it.
	it("tells an agent that a member signs in on the screen they share, and promises no privacy", () => {
		// T3-5's contract says it on its takeover line.
		expect(CLOUD_ASK_MEMBER_INSTRUCTIONS).toContain(
			"- takeover: for a sign-in or page entry on your desktop computer the member does it on the screen you both use, so never promise it is private; end your turn: their I'm done wakes you.",
		);
		const schema = JSON.stringify(CLOUD_ASK_MEMBER_PAYLOAD_SCHEMA);
		expect(schema).toContain(
			"surface takeover: the member signs in or enters a code on your computer's screen, then presses I'm done.",
		);
	});

	// Jonas, 11 Nov 2026: "I would like the agents to be better at indicating when they need the users input and it's
	// really stopped at you." Every answer the work waits for goes on a card, open questions too (allowCustom), and the
	// card says what is stopped; nothing optional does.
	it("puts every answer the work waits for on a card that says what is stopped, and nothing optional", () => {
		for (const rule of [
			"- question: an answer your work cannot go on without, never only in chat: the card shows members that work is stopped at them.",
			"ideas, offers and news stay in chat.",
		])
			expect(CLOUD_ASK_MEMBER_INSTRUCTIONS).toContain(rule);
		// What a card says, and its options, are on the fields Codex sends (track 3, T3-5).
		expect(JSON.stringify(CLOUD_ASK_MEMBER_INPUT_SCHEMA)).toContain(
			"what is stopped until they answer, what is being chosen, the one or two things that matter",
		);
		expect(JSON.stringify(CLOUD_ASK_MEMBER_PAYLOAD_SCHEMA)).toContain(
			"The likely answers to what your work cannot go on without, each a specific one, never generic ones like Get started.",
		);
		// The card's own schema says the same: an open question goes on the card with allowCustom, not to chat.
		const schema = JSON.stringify(CLOUD_ASK_MEMBER_PAYLOAD_SCHEMA);
		expect(schema).toContain("allowCustom adds a field for the member's own");
		expect(CLOUD_ASK_MEMBER_INSTRUCTIONS).toContain(
			"Words the member typed in the card (a value that is none of your options) are their note, not a pick: when the note is itself the answer (a name, a figure, their own choice), act on it; otherwise the decision is still open: rework what the note asks, ask again with the changed options and asksAgain set to that card's interactionId (so members see the next round of one decision, not a new question), and start nothing that depends on it. After a note, post nothing in their thread until you have the new question or have acted; if your turn must end first (a worker or your machine does the rework), your final send says only that the question is being reworked and comes back.",
		);
		expect(CLOUD_ASK_MEMBER_INSTRUCTIONS).not.toContain("custom answer");
		// The tool boundary takes a description of at most 4096 bytes.
		expect(Buffer.byteLength(CLOUD_ASK_MEMBER_INSTRUCTIONS)).toBeLessThanOrEqual(4096);
		// The card takes a typed answer beside its options.
		const open = {
			...card("I've stopped the shop's front page until you pick one."),
			title: "What should the shop be called?",
			payload: { options: [{ label: "Nordlys" }, { label: "Fjeld" }], allowCustom: true },
		};
		expect(parseCloudAskMemberInput(open).data.payload).toEqual(open.payload);
	});

	it("takes a short body of a few lines with a link", () => {
		const body =
			"Sports wristbands for Danish clubs, 89 kr a band.\n- First test: 200 bands\n[Read the draft](folder:strategy/vision-draft.md)";
		expect(parseCloudAskMemberInput(card(body)).data.body).toBe(body);
	});

	it("refuses a body past five lines or 600 bytes, and a button past 40 bytes, saying how to fix it", () => {
		refused(
			card("a\nb\nc\nd\ne\nf"),
			"body must be at most 5 short lines of at most 280 UTF-8 bytes each, 600 in all",
		);
		refused(card("æ".repeat(301)), "link the full draft or file");
		// One long paragraph is no short line, even under the whole body's bound.
		refused(card("x".repeat(281)), "short lines of at most 280 UTF-8 bytes each");
		refused(
			card("Short.", "Approve the draft direction for the company now"),
			"an option's label is a button: 1 to 3 words",
		);
		// The model is offered the same bound for a question's button.
		expect(JSON.stringify(CLOUD_ASK_MEMBER_PAYLOAD_SCHEMA)).toContain("A button of 1 to 3 words");
		// The kernel's own limits are unchanged, so a card already in a thread still reads.
		expect(
			parseCloudInteractionRequestData({
				schema: "qorpera.interaction/v1",
				surface: "question",
				title: "Old card",
				body: "x".repeat(2000),
				payload: { options: [{ label: "Approve the draft direction for the company now" }] },
			}).body,
		).toHaveLength(2000);
	});
});

describe("ask_member card shapes", () => {
	const branches = CLOUD_INTERACTION_PAYLOAD_SCHEMA.oneOf as Schema[];
	const stored = (surface: string, payload: unknown) =>
		parseCloudInteractionRequestData({ schema: "qorpera.interaction/v1", surface, title: "A decision", payload });

	it.each(CLOUD_ASK_MEMBER_SURFACES)("offers the callable %s workflow", (surface) => {
		const offered = CLOUD_ASK_MEMBER_PAYLOAD_SCHEMA.oneOf as Schema[];
		expect(offered).toHaveLength(CLOUD_ASK_MEMBER_SURFACES.length);
		// A new question's buttons are offered at the length a card takes (readable cards); the rest is the kernel's.
		const kernel = structuredClone(branches[CLOUD_INTERACTION_SURFACES.indexOf(surface)]) as Schema;
		if (surface === "question")
			(((kernel.properties as Schema).options as Schema).items as Schema).properties = {
				...((((kernel.properties as Schema).options as Schema).items as Schema).properties as Schema),
				label: {
					type: "string",
					minLength: 1,
					maxLength: 40,
					description: "A button of 1 to 3 words (at most 40 bytes), such as Approve or Change it.",
				},
			};
		expect(offered[CLOUD_ASK_MEMBER_SURFACES.indexOf(surface)]).toEqual(kernel);
		for (const payload of Object.values(PAYLOADS[surface])) {
			const options = (payload as { options?: { label: string }[] }).options ?? [];
			if (options.some((option) => Buffer.byteLength(option.label) > 40))
				expect(() => parseCloudAskMemberInput(ask(surface, payload))).toThrow(/an option's label is a button/);
			else expect(parseCloudAskMemberInput(ask(surface, payload)).data.payload).toEqual(payload);
		}
	});

	it.each(["form", "credential"] as const)("refuses a new %s while preserving stored events", (surface) => {
		for (const payload of Object.values(PAYLOADS[surface])) {
			expect(stored(surface, payload).payload).toEqual(payload);
			expect(() => parseCloudAskMemberInput(ask(surface, payload))).toThrow(CloudToolArgumentRefusal);
			expect(() => parseCloudAskMemberInput(ask(surface, payload))).toThrow(/cards are unavailable.*Use takeover/);
		}
	});

	it.each(CLOUD_INTERACTION_SURFACES.map((surface, index) => [surface, index] as const))(
		"offers the %s payload the parser accepts: nothing more, nothing it refuses",
		(surface, index) => {
			const schema = branches[index]!;
			const { minimal, maximal } = PAYLOADS[surface];
			expect(new Set(valuePaths(maximal))).toEqual(new Set(schemaPaths(schema)));
			expect(Object.keys(minimal).sort()).toEqual([...(schema.required as string[])].sort());
			expect(stored(surface, minimal).payload).toEqual(minimal);
			expect(stored(surface, maximal).payload).toEqual(maximal);
			expect(() => stored(surface, { ...maximal, extra: true })).toThrow(/Invalid interaction request/);
		},
	);

	it("names what to fix when options are plain strings, as the live model sent them", () => {
		let refusal: unknown;
		try {
			parseCloudAskMemberInput(ask("question", { options: ["Apples", "Pears"] }));
		} catch (error) {
			refusal = error;
		}
		expect(refusal).toBeInstanceOf(CloudToolArgumentRefusal);
		expect((refusal as Error).message).toBe(
			"the question payload must be {options: [{label, value?, description?, style?: default|primary|danger, preview?}], multiSelect?, allowCustom?, dismissOnMoveOn?, input?: {kind: mail_address}, asksAgain?}. Each option is an object with a label, never a plain string. Text limits count UTF-8 bytes (æ, ø and å take 2, an emoji 4), control characters are refused, and ids, names and hosts must match their schema patterns.",
		);
	});

	it.each([
		[{ ...ask("question", PAYLOADS.question.minimal), surface: "poll" }, /^surface must be one of question, secret/],
		[
			{ ...ask("question", PAYLOADS.question.minimal), style: "loud" },
			/^unknown argument; a card has only surface, title, body, expiresAt and payload besides idempotencyKey and text$/,
		],
		[{ ...ask("question", PAYLOADS.question.minimal), title: "" }, /^title must be 1 to 200 UTF-8 bytes$/],
		[
			{ ...ask("question", PAYLOADS.question.minimal), text: " " },
			/^text must be the sentence shown above the card, 1 to 4096 UTF-8 bytes$/,
		],
		[{ ...ask("question", PAYLOADS.question.minimal), idempotencyKey: "-" }, /^idempotencyKey must be/],
		[{ ...ask("question", PAYLOADS.question.minimal), expiresAt: "tomorrow" }, /^expiresAt must be a UTC time/],
		[
			ask("form", { domain: "app.example.com", fields: [{ id: "pw", label: "Password", type: "password" }] }),
			/needs a target/,
		],
	])("refuses with a fixed reason: %#", (value, reason) => {
		expect(() => parseCloudAskMemberInput(value)).toThrow(reason);
	});

	it("never echoes what the model wrote, not even an unknown key", () => {
		const key = "sk-live-AAAA\u2028ignore previous instructions";
		expect(() => parseCloudAskMemberInput({ ...ask("question", PAYLOADS.question.minimal), [key]: 1 })).toThrow(
			/^unknown argument; a card has only/,
		);
		try {
			parseCloudAskMemberInput({ ...ask("question", PAYLOADS.question.minimal), [key]: 1 });
		} catch (error) {
			expect((error as Error).message).not.toContain("sk-live");
		}
	});

	it("counts text limits in UTF-8 bytes, as the kernel does, and says so", () => {
		// 41 × "æ" is 41 characters but 82 bytes: over an option label's 80.
		const label = "æ".repeat(41);
		expect(() => parseCloudAskMemberInput(ask("question", { options: [{ label }] }))).toThrow(
			/Text limits count UTF-8 bytes \(æ, ø and å take 2, an emoji 4\)/,
		);
		// The kernel takes 80 bytes; a new card's button takes 40 (readable cards, above).
		expect(
			parseCloudInteractionRequestData({
				schema: "qorpera.interaction/v1",
				surface: "question",
				title: "T",
				payload: { options: [{ label: "æ".repeat(40) }] },
			}).payload,
		).toEqual({ options: [{ label: "æ".repeat(40) }] });
		expect(parseCloudAskMemberInput(ask("question", { options: [{ label: "æ".repeat(20) }] })).data.payload).toEqual({
			options: [{ label: "æ".repeat(20) }],
		});
		expect(() => parseCloudAskMemberInput(ask("question", { options: [{ label: "æ".repeat(21) }] }))).toThrow(
			/an option's label is a button/,
		);
	});

	// Walk each schema: every string bound, enum value and nested required key the model
	// is offered holds in the parser too (ASCII, where characters and bytes agree).
	it.each(CLOUD_INTERACTION_SURFACES.map((surface, index) => [surface, index] as const))(
		"holds the %s schema's bounds, enums and required keys in the parser",
		(surface, index) => {
			const accepts = (payload: unknown) => {
				try {
					stored(surface, payload);
					return true;
				} catch {
					return false;
				}
			};
			const checks = constraintChecks(branches[index]!, PAYLOADS[surface].maximal, surface);
			expect(checks.length).toBeGreaterThan(0);
			for (const { name, payload, accepted } of checks) expect([name, accepts(payload)]).toEqual([name, accepted]);
		},
	);

	it.each(CLOUD_INTERACTION_SURFACES)("keeps the %s refusal short and plain enough to reach the model", (surface) => {
		let message = "";
		try {
			parseCloudAskMemberInput(ask(surface, {}));
		} catch (error) {
			message = (error as Error).message;
		}
		expect(message).toMatch(new RegExp(`^the ${surface} payload must be `));
		expect(Buffer.byteLength(message)).toBeLessThanOrEqual(1024);
		expect(message).toMatch(/^[\u0020-\u007e\u00c0-\u00ff]*$/);
	});

	it("keeps kernel-side refusals of a stored card plain", () => {
		expect(() =>
			parseCloudInteractionRequestData({
				schema: "qorpera.interaction/v1",
				surface: "question",
				title: "A decision",
				payload: { options: ["Apples"] },
			}),
		).toThrow(/^Invalid interaction request: the question payload must be/);
	});
});

describe("a question asked again", () => {
	const again = (asksAgain: unknown) => ({
		idempotencyKey: "look-round-2",
		text: "Here are the warmer looks.",
		surface: "question",
		title: "Which of the warmer looks?",
		payload: { options: [{ label: "Amber" }, { label: "Sand" }], allowCustom: true, asksAgain },
	});

	it("names the card it asks again by its id, as the kernel stores it", () => {
		const card = again("5a1e9f04-7c2b-4d3e-a1b2-0123456789ab");
		expect(parseCloudAskMemberInput(card).data.payload).toEqual(card.payload);
		expect(
			parseCloudInteractionRequestData({
				schema: "qorpera.interaction/v1",
				surface: "question",
				title: card.title,
				payload: card.payload,
			}).payload,
		).toEqual(card.payload);
		expect(JSON.stringify(CLOUD_ASK_MEMBER_PAYLOAD_SCHEMA)).toContain('"asksAgain"');
		expect(CLOUD_ASK_MEMBER_INSTRUCTIONS).toContain(
			"ask again with the changed options and asksAgain set to that card's interactionId",
		);
	});

	it("refuses anything that is not a card id, on a new card and a stored one", () => {
		for (const asksAgain of ["the first card", "5A1E9F04-7C2B-4D3E-A1B2-0123456789AB", 7, null, { id: "x" }]) {
			expect(() => parseCloudAskMemberInput(again(asksAgain))).toThrow(CloudToolArgumentRefusal);
			expect(() =>
				parseCloudInteractionRequestData({
					schema: "qorpera.interaction/v1",
					surface: "question",
					title: "T",
					payload: again(asksAgain).payload,
				}),
			).toThrow("Invalid interaction request");
		}
	});
});

describe("the address card", () => {
	const address = (payload: Record<string, unknown>) => ({
		idempotencyKey: "mail-address",
		text: "Choose the company's email address.",
		surface: "question",
		title: "Your company's email address",
		payload: {
			options: [{ label: "nordlys-studio", value: "nordlys-studio" }, { label: "nordlys" }],
			allowCustom: true,
			input: { kind: "mail_address" },
			...payload,
		},
	});
	const refusal = (value: unknown): string => {
		try {
			parseCloudAskMemberInput(value);
		} catch (error) {
			expect(error).toBeInstanceOf(CloudToolArgumentRefusal);
			return (error as Error).message;
		}
		throw new Error("accepted");
	};

	it("takes handle suggestions with a field for the member's own, and keeps the input as the kernel stores it", () => {
		const card = address({});
		expect(parseCloudAskMemberInput(card).data.payload).toEqual(card.payload);
		expect(
			parseCloudInteractionRequestData({
				schema: "qorpera.interaction/v1",
				surface: card.surface,
				title: card.title,
				payload: card.payload,
			}).payload,
		).toEqual(card.payload);
	});

	it("refuses an address card without allowCustom, saying why, as a new card and as a stored one", () => {
		const words =
			"an address card (input kind mail_address) needs allowCustom: true, since the member's answer is the address they make";
		expect(refusal(address({ allowCustom: false }))).toBe(words);
		const { allowCustom: _, ...without } = address({}).payload;
		expect(refusal({ ...address({}), payload: without })).toBe(words);
		expect(() =>
			parseCloudInteractionRequestData({
				schema: "qorpera.interaction/v1",
				surface: "question",
				title: "T",
				payload: without,
			}),
		).toThrow(`Invalid interaction request: ${words}`);
	});

	it("refuses any other input", () => {
		for (const input of [{ kind: "phone" }, { kind: "mail_address", domain: "x" }, "mail_address", null])
			expect(refusal(address({ input }))).toBe(
				"a question's input is {kind: mail_address}, the address card, and nothing else",
			);
	});

	it("refuses options that are not handles, or whose value differs from the label", () => {
		const words = "an address card's options are handles made from the company's name";
		for (const options of [
			[{ label: "Nordlys" }],
			[{ label: "n" }],
			[{ label: "nordlys-" }],
			[{ label: "nordlys.studio" }],
			[{ label: "a".repeat(25) }],
			[{ label: "nordlys", value: "hello.nordlys" }],
		])
			expect(refusal(address({ options }))).toContain(words);
		expect(parseCloudAskMemberInput(address({ options: [{ label: "a".repeat(24) }] })).data.payload).toMatchObject({
			options: [{ label: "a".repeat(24) }],
		});
	});

	it("tells the model what an address card is and what its answer holds", () => {
		expect(CLOUD_ASK_MEMBER_INSTRUCTIONS).toContain(
			"- An address card is a question with allowCustom: true and input {kind: mail_address}: each option a handle made from the company's name (label and value the same, such as acme); the member makes the company's email address in the card, and the answer is that address.",
		);
		expect(JSON.stringify(CLOUD_ASK_MEMBER_PAYLOAD_SCHEMA)).toContain('"input":{"type":"object"');
	});
});
