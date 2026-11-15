import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { finish, pass, proveCompanyRun, repositoryRoot } from "./prove-company-run.mjs";

// Tools on demand (agents' instructions, track 3, T3-6): a run opens a tool its catalog does not describe through
// more_tools, and its call is exactly the direct call of that tool. End to end, through the real patched Codex and a
// migrated database (scripts/prove-company-run.mjs says what is real and what stands in):
//
//   QORPERA_CODEX_FENCE_BINARY=<patched codex> node scripts/prove-tools-on-demand.mjs
//
// Two runs of Alice's, each with the folder file tools and her notebook's tools (update_memory, recall_memory), made by
// the runtime's own factories over the real folder client, and an action review that records what it is asked and lets
// every call run (the company runtime's auto-review asks the same question of every call; its verdicts are not proved
// here):
// - Direct, as every run before T3-6 and as base: its catalog describes every tool; the model calls update_memory.
// - On demand, as a worker's run is offered its tools: the catalog leaves update_memory, company_move and
//   company_delete to more_tools. The model describes update_memory, uses it with the same arguments, uses it with
//   arguments that do not fit, uses a tool the run does not have, and calls update_memory by its own name (Codex
//   answers that itself; the result fence turns its answer into the way to open it).
// Checked: what the provider is sent (more_tools, not the three, and how Codex sends more_tools' form); each answer the
// model gets; and, between the two runs, the same receipt, the same review question and the same work-log step for the
// change. Prints one PASS line per check and exits 1 on the first failure; without the binary it prints NOT RUN.

const FACT = "Jonas likes short replies with the numbers first.";
const WRITE = { action: "write", fact: FACT, tier: "profile" };

async function bundle(scratch) {
	const modulePath = join(scratch, "tools-on-demand.mjs");
	const src = (file) => `./packages/runtime/src/${file}.ts`;
	await build({
		absWorkingDir: repositoryRoot,
		stdin: {
			resolveDir: repositoryRoot,
			contents: [
				`export {CloudFolderNotebooks} from "${src("cloud-folder-notebooks")}";`,
				`export {cloudMemoryTools} from "${src("cloud-memory-tools")}";`,
				`export {CLOUD_MORE_TOOLS, cloudToolForm} from "${src("cloud-native-tool-boundary")}";`,
				'export {cloudAgentFolder} from "./packages/cloud-client/src/cloud-agent-folder.ts";',
			].join("\n"),
		},
		platform: "node",
		format: "esm",
		target: "node22",
		bundle: true,
		outfile: modulePath,
		logLevel: "silent",
	});
	return import(pathToFileURL(modulePath).href);
}

/** One run's record: its notebook tools as made, the review's questions, and what was stored. */
function recorder(mine) {
	const run = { tools: null, reviewed: [] };
	return {
		run,
		tools: (_code, { folder, operations, identity }) => {
			const place = { core: "folder-v2", handle: "alice" };
			const notebooks = new mine.CloudFolderNotebooks({
				folder,
				runId: identity.runId,
				agentFolder: mine.cloudAgentFolder(identity.companyId, identity.staffAgentId, place),
			});
			run.tools = notebooks.tools((files) => mine.cloudMemoryTools(files, identity, place), operations);
			return run.tools;
		},
		review: {
			check: async (call) => {
				run.reviewed.push({
					tool: call.tool.name,
					parsed: call.parsed,
					argumentsText: call.argumentsText,
					argumentSha256: call.argumentSha256,
				});
				return { run: true };
			},
		},
	};
}

/** The run's receipts as stored, oldest first. */
const receiptsOf = (db, runId) =>
	db.json(`select coalesce(jsonb_agg(jsonb_build_object('kind', r.operation_kind, 'key', r.logical_operation_key,
		'input', r.input_sha256, 'status', r.status, 'committed', r.folder_commit_id is not null) order by r.created_at), '[]')::text
		from public.qorpera_run_operation_receipts r where r.run_id = '${runId}'`);

/** A text with every id (a uuid) the database made for its run written as <id>. */
const ids = (text) => (typeof text === "string" ? text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<id>") : text);

/** A work-log step as the two runs can be compared: what does not name the run, its call or its time. */
function stepOf(step) {
	const { j, tool, args, args_bytes: argsBytes, result, paths } = step.value;
	return {
		j,
		tool,
		args,
		argsBytes,
		status: result?.status,
		resultTool: result?.provenance?.tool,
		argumentSha256: result?.provenance?.argumentSha256,
		text: ids(result?.content?.text),
		paths,
	};
}

async function main() {
	const scratch = await mkdtemp(join(tmpdir(), "prove-tools-on-demand-"));
	try {
		const mine = await bundle(scratch);
		const direct = recorder(mine);
		const onDemand = recorder(mine);
		const stored = {};
		await proveCompanyRun({
			name: "qorpera_prove_tools_direct",
			prompt: "Remember how Jonas likes his replies.",
			setup: "",
			objects: new Map(),
			// The change's call id is the same in both runs: a new file's operation key binds the call that made it.
			calls: [() => ({ id: "call_change", name: "update_memory", arguments: WRITE })],
			tools: direct.tools,
			review: direct.review,
			check: async ({ db, binding, state, outputs, log }) => {
				const sent = state.agent[0].body.input[0].tools[0].tools.map((tool) => tool.name);
				assert(sent.includes("update_memory") && !sent.includes(mine.CLOUD_MORE_TOOLS), JSON.stringify(sent));
				assert.equal(outputs[0].envelope.status, "ok", outputs[0].text);
				stored.direct = {
					receipts: receiptsOf(db, binding.runId),
					steps: log.steps.map(stepOf),
					output: outputs[0],
				};
				pass(`direct: the catalog describes update_memory (${sent.length} tools), and its call wrote the fact`);
			},
		});
		await proveCompanyRun({
			name: "qorpera_prove_tools_on_demand",
			prompt: "Remember how Jonas likes his replies.",
			setup: "",
			objects: new Map(),
			// As a worker's run is offered its tools: update_memory stays on demand there (a staff run carries it in full).
			onDemand: "worker",
			calls: [
				() => ({ name: "more_tools", arguments: { action: "describe", names: ["update_memory"] } }),
				() => ({ id: "call_change", name: "more_tools", arguments: { action: "use", name: "update_memory", arguments: WRITE } }),
				() => ({ name: "more_tools", arguments: { action: "use", name: "update_memory", arguments: { action: "write" } } }),
				() => ({ name: "more_tools", arguments: { action: "use", name: "interface_read", arguments: {} } }),
				// The tool by its own name, which the catalog Codex holds does not have (arguments that would not run).
				() => ({ name: "update_memory", arguments: { action: "write" } }),
			],
			tools: onDemand.tools,
			review: onDemand.review,
			check: async ({ db, binding, state, outputs, log }) => {
				// What the provider is sent: more_tools, never the tools it opens, in every request of the run.
				for (const request of state.agent) {
					const sent = request.body.input[0].tools[0].tools;
					const names = sent.map((tool) => tool.name);
					for (const name of ["update_memory", "company_move", "company_delete"]) assert(!names.includes(name), name);
					assert(names.includes(mine.CLOUD_MORE_TOOLS));
				}
				const first = state.agent[0].body.input[0].tools[0];
				const more = first.tools.find((tool) => tool.name === mine.CLOUD_MORE_TOOLS);
				process.stdout.write(`more_tools as sent: ${JSON.stringify(more)}\n`);
				process.stdout.write(`namespace description as sent: ${JSON.stringify(first.description)}\n`);
				assert.deepEqual(Object.keys(more.parameters.properties).sort(), ["action", "arguments", "name", "names"]);
				for (const name of ["company_move", "company_delete", "update_memory"])
					assert(more.description.includes(`\n- ${name}: `), name);
				pass(
					`on demand: every request carries ${first.tools.length} tools, more_tools among them (${Buffer.byteLength(JSON.stringify(more))} B as sent), and lists company_move, company_delete and update_memory`,
				);
				// 1. describe: the tool's description and its whole form.
				const update = onDemand.run.tools.find((tool) => tool.name === "update_memory");
				assert.equal(outputs[0].envelope.status, "ok");
				assert.equal(outputs[0].envelope.provenance.tool, mine.CLOUD_MORE_TOOLS);
				assert.equal(outputs[0].text, mine.cloudToolForm(update));
				pass(`describe answered update_memory's description and form whole (${outputs[0].bytes} B as the model got it)`);
				// 2. use: the call of update_memory itself.
				assert.equal(outputs[1].envelope.status, "ok", outputs[1].text);
				assert.equal(outputs[1].envelope.provenance.tool, "update_memory");
				pass("use ran update_memory: the answer's provenance names update_memory");
				// 3. use with arguments that do not fit: refused, with the form, nothing run.
				assert.equal(outputs[2].envelope.status, "denied");
				assert.equal(outputs[2].envelope.provenance.tool, "update_memory");
				assert(outputs[2].text.startsWith("INVALID_ARGUMENTS"), outputs[2].text);
				assert(
					outputs[2].text.endsWith(
						`\nWhat update_memory takes, to call it again through more_tools use:\n${mine.cloudToolForm(update)}`,
					),
				);
				pass("a use whose arguments do not fit was refused with update_memory's form");
				// 4. use of a tool the run does not have: more_tools refuses it.
				assert.equal(outputs[3].envelope.status, "denied");
				assert.equal(outputs[3].envelope.provenance.tool, mine.CLOUD_MORE_TOOLS);
				assert(outputs[3].text.startsWith("INVALID_ARGUMENTS: use: name is not one of your tools"), outputs[3].text);
				pass("a use of a tool the run lacks was refused by more_tools, and reached nothing");
				// 5. The tool by its own name: Codex answers that call itself; the fence tells the model to open it.
				process.stdout.write(`a direct call of update_memory got: ${outputs[4].text}\n`);
				assert.equal(outputs[4].envelope.status, "denied", outputs[4].text);
				assert(
					outputs[4].text.startsWith("TOOL_UNAVAILABLE: update_memory is one of your tools that more_tools opens"),
					outputs[4].text,
				);
				pass("a call of update_memory by its own name, which Codex does not hold, told the model to open it through more_tools");
				stored.onDemand = {
					receipts: receiptsOf(db, binding.runId),
					steps: log.steps.map(stepOf),
					output: outputs[1],
				};
			},
		});
		// The two runs, side by side.
		const { direct: a, onDemand: b } = stored;
		process.stdout.write(`receipts direct: ${JSON.stringify(a.receipts)}\nreceipts on demand: ${JSON.stringify(b.receipts)}\n`);
		// A receipt's input digest covers the run's identity with the operation (cloudNativeToolOperationEnvelope), so it
		// is the run's own; the rest is the operation's.
		const kept = (receipts) =>
			receipts.filter((receipt) => receipt.key.startsWith("update_memory:")).map(({ input: _input, ...receipt }) => receipt);
		assert.equal(kept(a.receipts).length, 1);
		assert.deepEqual(kept(b.receipts), kept(a.receipts));
		assert.equal(b.receipts.length, a.receipts.length, "no other receipt in either run");
		pass(
			`the same receipt: ${JSON.stringify(kept(b.receipts)[0])} (the same operation key, completed, with its folder commit; its input digest binds its own run)`,
		);
		const asked = (run) => run.reviewed.filter((call) => call.tool === "update_memory");
		process.stdout.write(`review direct: ${JSON.stringify(asked(direct.run))}\nreview on demand: ${JSON.stringify(asked(onDemand.run))}\n`);
		assert.equal(asked(direct.run).length, 1);
		assert.deepEqual(asked(onDemand.run), asked(direct.run));
		assert.deepEqual(
			onDemand.run.reviewed.map((call) => call.tool),
			[mine.CLOUD_MORE_TOOLS, "update_memory"],
			"the review is asked of the describe and of the use; never of a call whose arguments were refused",
		);
		pass("the same review question: update_memory, its parsed arguments, argument text and digest (an approval card keys on it)");
		const change = (steps) => steps.filter((step) => step.tool === "update_memory" && step.status === "ok");
		process.stdout.write(`step direct: ${JSON.stringify(change(a.steps))}\nstep on demand: ${JSON.stringify(change(b.steps))}\n`);
		assert.equal(change(a.steps).length, 1);
		assert.deepEqual(
			change(b.steps).map(({ j: _j, ...step }) => step),
			change(a.steps).map(({ j: _j, ...step }) => step),
		);
		assert.deepEqual(
			b.steps.map((step) => [step.tool, step.status]),
			[
				[mine.CLOUD_MORE_TOOLS, "ok"],
				["update_memory", "ok"],
				["update_memory", "denied"],
				[mine.CLOUD_MORE_TOOLS, "denied"],
			],
		);
		pass("the same work-log step for the change: update_memory, its arguments, digest, answer and paths");
		assert.equal(ids(b.output.envelope.content.text), ids(a.output.envelope.content.text));
		assert.equal(b.output.envelope.provenance.argumentSha256, a.output.envelope.provenance.argumentSha256);
		pass("the same answer to the model, but for the ids each database made");
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}

finish(main());
