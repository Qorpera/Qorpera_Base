// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import conversationCss from "../src/styles/conversation.css?raw";
import { inlineColorValue, markdown, markdownBubbles, markdownSourceOffset } from "../src/ui/markdown.ts";

afterEach(() => {
	document.body.replaceChildren();
	vi.restoreAllMocks();
});

describe("inline color codes in markdown", () => {
	it.each([
		"#fff",
		"#fff8",
		"#F4F7FA",
		"#FFFFFF",
		"#D9E7F0",
		"#143C63",
		"#526C80",
		"#000000",
		"#17232B",
		"#7FB5E5",
		"#143c6380",
		"rgb(20, 60, 99)",
		"rgba(20, 60, 99, 0.5)",
		"rgb(20, 60, 99, 50%)",
		"rgb(100%, 50%, 0%)",
		"rgb(20 60 99)",
		"rgb(20 60 99 / 50%)",
		"rgba(20 60 99 / .4)",
		"hsl(210, 66%, 23%)",
		"hsla(210deg, 66%, 23%, 0.5)",
		"hsl(0.5turn 66% 23% / 50%)",
		"hwb(210 8% 61%)",
		"hwb(210deg 8% 61% / 0.8)",
		"oklch(0.65 0.15 240)",
		"OKLCH(65% 0.15 240deg / 50%)",
		"oklab(0.65 -0.1 -0.05)",
		"lab(30% -5 -25)",
		"lch(30% 25 250 / 0.5)",
		"color(display-p3 0.1 0.3 0.6 / 0.8)",
	])("marks inline color code %s with a CSSOM swatch variable", (value) => {
		const setAttribute = vi.spyOn(Element.prototype, "setAttribute");
		const rendered = markdown(`Use \`${value}\` here.`);
		const code = rendered.querySelector("code");
		expect(code?.textContent).toBe(value);
		expect(code?.classList.contains("is-color")).toBe(true);
		expect(code?.style.getPropertyValue("--code-color").trim()).toBe(value);
		expect(code?.childNodes).toHaveLength(1);
		expect(setAttribute.mock.calls.some(([name]) => name === "style")).toBe(false);
	});

	it.each([
		"",
		"--q-color-primary-on-dark",
		"--q-color-dark",
		"fill",
		"red",
		"white",
		"black",
		"transparent",
		"currentColor",
		"#12",
		"#12345",
		"#1234567",
		"#123456789",
		"#gggggg",
		"#F4F7FA,",
		"#143C63;",
		"color: #143C63",
		"rgb(r, g, b)",
		"hsl(h, s, l)",
		"oklch(l c h)",
		"rgb(20, 60)",
		"rgb(20, 60, 99, 1, 2)",
		"rgb(20, 60%, 99)",
		"rgb(20, 60, 99 / 0.5)",
		"hsl(210, 66, 23)",
		"hwb(210 8 61)",
		"oklch(0.65, 0.15, 240)",
		"color(unknown 0.1 0.2 0.3)",
		"#fff; background: url(https://evil.example)",
		`rgb(${" ".repeat(70)}1, 2, 3)`,
		"rgb(20,\u00a060,\u00a099)",
	])("leaves non-color inline code %s without a swatch", (value) => {
		expect(inlineColorValue(value)).toBeUndefined();
		const rendered = markdown(`Code: \`${value}\``);
		const code = rendered.querySelector("code");
		if (code) {
			expect(code.classList.contains("is-color")).toBe(false);
			expect(code.style.getPropertyValue("--code-color")).toBe("");
		}
	});

	it("renders inline color swatches in markdownBubbles while ignoring fenced code blocks and plain text", () => {
		const bubbles = markdownBubbles("Use `#143C63` and `--q-color-dark`, not #143C63.\n\n```css\n#143C63\n```");
		const inlineCodes = bubbles[0]?.querySelectorAll("code") ?? [];
		expect(inlineCodes).toHaveLength(2);
		expect(inlineCodes[0]?.classList.contains("is-color")).toBe(true);
		expect(inlineCodes[0]?.style.getPropertyValue("--code-color").trim()).toBe("#143C63");
		expect(inlineCodes[1]?.classList.contains("is-color")).toBe(false);
		expect(bubbles[0]?.querySelectorAll(".is-color")).toHaveLength(1);
		const blockCode = bubbles[1]?.querySelector("pre code");
		expect(blockCode?.textContent).toBe("#143C63");
		expect(blockCode?.classList.contains("is-color")).toBe(false);
	});

	it("keeps exact source offsets inside inline color codes", () => {
		const source = "På `#F4F7FA` og `#143C63`.";
		const root = markdown(source, { links: false, sourceRanges: true });
		const codes = [...root.querySelectorAll("code")];
		expect(codes).toHaveLength(2);
		expect(markdownSourceOffset(codes[0]!, 0)).toBe(source.indexOf("#F4F7FA"));
		expect(markdownSourceOffset(codes[0]!.firstChild!, 4)).toBe(source.indexOf("#F4F7FA") + 4);
		expect(markdownSourceOffset(codes[1]!, 0)).toBe(source.indexOf("#143C63"));
		expect(markdownSourceOffset(codes[1]!.firstChild!, 7)).toBe(source.indexOf("#143C63") + 7);
	});

	it("styles inline color swatches in conversation.css with a theme-adaptive border", () => {
		expect(conversationCss).toMatch(/\.message-prose code\.is-color \{[^}]*display: inline-flex;/);
		expect(conversationCss).toMatch(
			/\.message-prose code\.is-color::before \{[^}]*background: var\(--code-color\);[^}]*box-shadow: inset 0 0 0 1px color-mix\(in srgb, var\(--text\)/,
		);
	});
});
