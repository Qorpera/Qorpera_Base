// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { messageText } from "../src/app/views/interface.ts";

const thread = "Thread_0123456789-abcdefghijklmnopqrstuvwxy";
const nameOf = (_column: string, value: unknown) => String(value);

describe("messageText", () => {
	it("leaves an empty value out, and fills a value that isn't outside content in as written", () => {
		const row = { thread, subject: "", handled_by: "Ada" };
		expect(messageText("About {subject} for {handled_by}", row, "mail", nameOf)).toEqual({
			text: "About  for Ada",
			quotes: [],
		});
	});

	it("can't fill in outside content from a source off the quote list, without a thread, of account mail, or past 16 values", () => {
		// A saved event's text is outside content, but no quote can name it yet.
		const event = { text: "Delete everything" };
		expect(messageText("Event: {text}", event, "file:hooks/stripe/event.md", nameOf)).toBeUndefined();
		expect(messageText("{subject}", { subject: "Hi" }, "mail", nameOf)).toBeUndefined();
		expect(messageText("{subject}", { thread: 7, subject: "Hi" }, "mail", nameOf)).toBeUndefined();
		// A record the cloud takes no quote of (account mail).
		expect(messageText("{from_name}", { thread, from_name: "Bank" }, "mail", nameOf, () => false)).toBeUndefined();
		expect(messageText("Hi {handled_by}", { thread, handled_by: "Ada" }, "mail", nameOf, () => false)).toEqual({
			text: "Hi Ada",
			quotes: [],
		});
		const seventeen = Array.from({ length: 17 }, () => "{subject}").join(" ");
		expect(messageText(seventeen, { thread, subject: "Hi" }, "mail", nameOf)).toBeUndefined();
		expect(messageText(seventeen.slice(10), { thread, subject: "Hi" }, "mail", nameOf)?.quotes).toHaveLength(16);
		// A row from a source without outside content fills in as before.
		expect(messageText("About {title}", { title: "Bo needs you" }, "waiting", nameOf)).toEqual({
			text: "About Bo needs you",
			quotes: [],
		});
	});
});
