import assert from "node:assert/strict";
import { answerOf, finish, pass, platformCommit, proveCompanyRun, textObjects } from "./prove-company-run.mjs";

// What a model receives of the interface app tools, through the real patched Codex (deploy/first-node/
// RUNTIME-INTERFACE-APPS.md §3d). Until 14 November 2026 the guides for making an app stood on the fields of save_app's
// schema, and no model received one: Codex sends no field description of a schema of 5,000 bytes or more. Nobody had
// read a request as the model gets it. This reads one:
// 1. the first request carries save_app with its fields' descriptions (which kit draws what, where the guides are), and
//    app_guide with its ten guides;
// 2. a kit's file from a run that has not read the kit's guide is not saved, and the answer names the guide;
// 3. app_guide's answer reaches the model whole: the guide's text, byte for byte;
// 4. the same save then applies, with the data the guide's own example gives (taken from the answer the model got).
// The harness and its stand-ins are prove-company-run.mjs's; no model is called.

const NOTE = "# Notes\n";
const save = (key, data) => ({
	name: "economy",
	operationKey: key,
	manifest: { title: "Economy", kit: "model" },
	files: [{ path: "model.json", text: data }],
});
const descriptions = (schema) => JSON.stringify(schema).match(/"description":/g)?.length ?? 0;

finish(
	proveCompanyRun({
		name: "qorpera_prove_app_guide",
		prompt: "Make the company's economy app.",
		setup: platformCommit("app-guide-notes", [
			{ op: "mkdir", path: "notes" },
			{ op: "write", path: "notes/a.md", text: NOTE },
		]),
		objects: textObjects([NOTE]),
		tools: (code, { folder, operations, identity }) => code.cloudAppTools({ folder, operations, identity }),
		calls: [
			// What an agent wrote on production, having never been given the guide.
			() => ({ name: "save_app", arguments: save("make-1", '{"groups":[]}') }),
			() => ({ name: "app_guide", arguments: { about: "model" } }),
			(outputs) => {
				const example = /```json\n([\s\S]*?)\n```/.exec(answerOf(outputs[1].output).text)?.[1];
				assert(example, "the model kit's guide, as the model got it, holds an example");
				return { name: "save_app", arguments: save("make-1", example) };
			},
		],
		check: async ({ code, run, outputs, state }) => {
			const namespace = state.agent[0].body.input.find((item) => item.type === "additional_tools").tools[0];
			const sent = (name) => namespace.tools.find((tool) => tool.name === name);
			const saveApp = sent("save_app");
			const fields = saveApp.parameters.properties;
			const bytes = Buffer.byteLength(JSON.stringify(saveApp.parameters));
			process.stdout.write(
				`save_app as sent: ${Buffer.byteLength(JSON.stringify(saveApp))} bytes, parameters ${bytes}, descriptions kept ${descriptions(saveApp.parameters)}\n`,
			);
			assert(bytes < 5000, "save_app's schema is under the bound");
			assert.equal(descriptions(saveApp.parameters), 6);
			assert(fields.manifest.properties.kit.description.includes("model: how something works in numbers"));
			assert(fields.manifest.properties.kit.description.includes("Before your first app, read app_guide look."));
			assert(fields.manifest.properties.reads.description.includes("app_guide reads says how"));
			assert(fields.manifest.properties.writes.description.includes("app_guide writes says how"));
			assert(fields.manifest.properties.emblem.description.includes("app_guide icons says how to draw those"));
			assert(fields.files.description.includes("app_guide style says what every such page starts from"));
			assert(fields.group.description.includes("organize_apps list shows them"));
			pass("the model receives save_app's fields with their descriptions: which kit draws what, and where each guide is");
			assert.deepEqual(sent("app_guide").parameters.properties.about.enum, [
				"look",
				"model",
				"board",
				"path",
				"object",
				"explainer",
				"style",
				"reads",
				"writes",
				"icons",
			]);
			pass("the model is offered app_guide with its ten guides");

			const [blind, guide, saved] = outputs;
			assert.equal(blind.envelope.status, "denied");
			assert(
				blind.text.includes(
					"APP_GUIDE_UNREAD: this call saved nothing. Read the model kit's guide first: it says what model.json holds and gives an example. Call app_guide with about model, check model.json against it, then make this call again.",
				),
				blind.text,
			);
			pass("a kit's file from a run that has not read the kit's guide is not saved, and the answer names the guide");

			assert.equal(guide.envelope.status, "ok");
			assert.equal(guide.envelope.content.truncated, false);
			assert.equal(guide.text, code.appGuide("model"));
			process.stdout.write(`app_guide model: ${Buffer.byteLength(guide.text)} bytes of guide in a result of ${guide.bytes}\n`);
			pass("app_guide's answer reaches the model whole: the model kit's guide, byte for byte");

			assert.equal(saved.envelope.status, "ok");
			assert.equal(JSON.parse(saved.text).state, "applied");
			for (const path of ["apps/economy/model.json", "apps/economy/engine.js", "apps/economy/index.html"]) {
				const found = await run.folder.read(path, AbortSignal.timeout(30_000));
				assert.equal(found.entry?.kind, "file", path);
			}
			pass("with the guide read, the same save applies: the data of the guide's own example, and the kit's page and engine");
		},
	}),
);
