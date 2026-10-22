import { isCloudSkillName, parseCloudSkillFile, renderCloudSkillFile } from "@qorpera/cloud-client/cloud-skill-file";
import { describe, expect, it } from "vitest";

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

describe("skill names", () => {
	it("never takes the skills folder's README.md for a skill, in any spelling of its key", () => {
		// skills/README.md, skills/readme.md and a skills/readme/ folder all have the key skills/readme(.md): the agents'
		// skill tools and the web's skill list ask isCloudSkillName before they list, find, read or write a skill.
		for (const name of ["readme", "README", "ReadMe"]) expect(isCloudSkillName(name), name).toBe(false);
		for (const name of ["readme-2", "read-me", "readmes", "pdf-forms"])
			expect(isCloudSkillName(name), name).toBe(true);
		expect(isCloudSkillName("x".repeat(65))).toBe(false);
		expect(isCloudSkillName("Pdf-Forms")).toBe(false);
	});
});

describe("skill files", () => {
	it("reads the front matter shapes skills are written in, and keeps other keys on rewrite", () => {
		const document = parseCloudSkillFile(imported);
		expect(document.description).toBe("Fill in PDF forms and flatten them. Use when a member sends a PDF form.");
		expect(document.fields.get("name")?.value).toBe("pdf-forms");
		expect(document.fields.get("metadata")?.value).toBeNull();
		expect(document.body).toBe("# PDF forms\n\n1. Read the form fields.\n");
		expect(parseCloudSkillFile('---\nname: a\ndescription: "Quoted: \\"yes\\""\n---\nx').description).toBe(
			'Quoted: "yes"',
		);
		expect(parseCloudSkillFile("---\nname: a\ndescription: 'It''s plain' # note\n---\nx").description).toBe(
			"It's plain",
		);
		expect(parseCloudSkillFile("---\ndescription: plain words # comment\n---\nx").description).toBe("plain words");
		expect(parseCloudSkillFile("---\ndescription: |\n  line one\n  line two\n---\n").description).toBe(
			"line one line two",
		);
		expect(parseCloudSkillFile("---\ndescription:\n  Starts on the next line.\n---\n").description).toBe(
			"Starts on the next line.",
		);
		expect(parseCloudSkillFile("\uFEFF---\nname: a\ndescription: After a byte order mark.\n---\nx").description).toBe(
			"After a byte order mark.",
		);
		// No front matter: the whole file is the body, and it has no description.
		expect(parseCloudSkillFile("# Steps\n1. Do it.\n")).toMatchObject({
			front: null,
			description: null,
			body: "# Steps\n1. Do it.\n",
		});
		// A body change keeps the front matter line for line; a new description replaces the old block.
		expect(renderCloudSkillFile("pdf-forms", { body: "New steps." }, document)).toBe(
			`${imported.split("---\n\n")[0]}---\n\nNew steps.\n`,
		);
		const described = renderCloudSkillFile("pdf-forms", { description: "Fill PDF forms.", body: "x" }, document);
		expect(described).toBe(
			'---\nname: pdf-forms\ndescription: "Fill PDF forms."\nlicense: Apache-2.0\nmetadata:\n  author: someone\n---\n\nx\n',
		);
		expect(parseCloudSkillFile(described).description).toBe("Fill PDF forms.");
		expect(renderCloudSkillFile("new-one", { description: 'Say "hi".', body: "\n\nSteps\n\n" })).toBe(
			'---\nname: new-one\ndescription: "Say \\"hi\\"."\n---\n\nSteps\n',
		);
	});
});
