import { CloudToolArgumentRefusal } from "@qorpera/runtime/cloud-native-tool-boundary";
import {
	CLOUD_ASK_MEMBER_PAYLOAD_SCHEMA,
	CLOUD_INTERACTION_SURFACES,
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
			options: [{ label: "Apples", value: "apples", description: "Crisp.", style: "primary" }],
			multiSelect: false,
			allowCustom: true,
			dismissOnMoveOn: false,
		},
	},
	secret: {
		minimal: { name: "api-key", label: "API key", purpose: "Filing issues." },
		maximal: { name: "api-key", label: "API key", purpose: "Filing issues.", kind: "token", connectorId: "linear" },
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

describe("ask_member card shapes", () => {
	const branches = CLOUD_ASK_MEMBER_PAYLOAD_SCHEMA.oneOf as Schema[];

	it.each(CLOUD_INTERACTION_SURFACES.map((surface, index) => [surface, index] as const))(
		"offers the %s payload the parser accepts: nothing more, nothing it refuses",
		(surface, index) => {
			const schema = branches[index]!;
			const { minimal, maximal } = PAYLOADS[surface];
			expect(new Set(valuePaths(maximal))).toEqual(new Set(schemaPaths(schema)));
			expect(Object.keys(minimal).sort()).toEqual([...(schema.required as string[])].sort());
			expect(parseCloudAskMemberInput(ask(surface, minimal)).data.payload).toEqual(minimal);
			expect(parseCloudAskMemberInput(ask(surface, maximal)).data.payload).toEqual(maximal);
			expect(() => parseCloudAskMemberInput(ask(surface, { ...maximal, extra: true }))).toThrow(
				CloudToolArgumentRefusal,
			);
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
			"the question payload must be {options: [{label, value?, description?, style?: default|primary|danger}], multiSelect?, allowCustom?, dismissOnMoveOn?}. Each option is an object with a label, never a plain string. Text limits count UTF-8 bytes (æ, ø and å take 2, an emoji 4), control characters are refused, and ids, names and hosts must match their schema patterns.",
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
		expect(parseCloudAskMemberInput(ask("question", { options: [{ label: "æ".repeat(40) }] })).data.payload).toEqual({
			options: [{ label: "æ".repeat(40) }],
		});
	});

	// Walk each schema: every string bound, enum value and nested required key the model
	// is offered holds in the parser too (ASCII, where characters and bytes agree).
	it.each(CLOUD_INTERACTION_SURFACES.map((surface, index) => [surface, index] as const))(
		"holds the %s schema's bounds, enums and required keys in the parser",
		(surface, index) => {
			const accepts = (payload: unknown) => {
				try {
					parseCloudAskMemberInput(ask(surface, payload));
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
