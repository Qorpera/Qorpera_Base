import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { answerOf, ENVIRONMENT, finish, pass, proveCompanyRun, repositoryRoot } from "./prove-company-run.mjs";

const PROFILE = "92400000-0000-4000-8000-000000000010";
const OWNER = "92400000-0000-4000-8000-000000000001";
const ALICE = "92400000-0000-4000-8000-000000000030";
const BOB = "92400000-0000-4000-8000-000000000031";
const COFOUNDER = "92400000-0000-4000-8000-000000000033";
const FIXTURE_AGENTS = [COFOUNDER, ALICE, BOB, "92400000-0000-4000-8000-000000000032"];
const REQUEST = "Hire the team we talked about: the eight areas, so everyone can start today.";
const AREAS = [
	["Kundeindsigt", "Customer insight"],
	["Strategi", "Strategy"],
	["Produkt", "Product owner"],
	["Måleteknik", "Measurement technology"],
	["Industridesign", "Industrial design"],
	["Appudvikling", "App development"],
	["Brand", "Brand"],
	["Salg", "Sales"],
];
const hire = ([name, role]) => ({
	name,
	role,
	jobDescription: `Own ${role.toLowerCase()} for the company: decide what it needs, do it, and tell the founders what changed.`,
	firstAssignment: `Write a first page on ${role.toLowerCase()}: what we know, what we do not, and the next three steps.`,
	figure: "acorn",
});
const TEAM = { operationKey: "first-team", hires: AREAS.map(hire) };
const NINTH = { operationKey: "later-hire", ...hire(["Økonomi", "Bookkeeping"]) };

function helpers() {
	const fixture = readFileSync(join(repositoryRoot, "supabase/tests/924_folder_runtime_base.test.sql"), "utf8");
	const start = fixture.indexOf("create function pg_temp.base_claims");
	const end = fixture.indexOf("-- END BASE HELPERS");
	assert(start > 0 && end > start, "SQL test 924's helpers moved: update this script");
	return fixture.slice(start, end);
}

function session(db, body) {
	const out = db.query(`begin;
		${helpers()}
		select pg_temp.base_claims('service_role') \\g /dev/null
		${body}
		commit;`);
	return JSON.parse(out.split("\n").at(-1));
}

function firstRuns(db, agents) {
	session(db, "select pg_temp.base_follow_ups() \\g /dev/null\nselect 'null';");
	const pass = session(db, "select pg_temp.base_materialize()::text;");
	assert.equal(pass.state, "done", `the materializer pass: ${JSON.stringify(pass)}`);
	return pass.run_ids
		.map(() => {
			const binding = session(db, "select pg_temp.base_start(null)::text;");
			const agent = db.query(`select staff_agent_id from public.qorpera_execution_runs where id = '${binding.runId}'`);
			const context = db.direct("qorpera_describe_company_run_context", { p_binding: binding });
			return { run: binding.runId, agent, binding, context };
		})
		.filter((run) => agents.includes(run.agent))
		.sort((a, b) => a.agent.localeCompare(b.agent));
}

const coworkersOf = (context) => context.coworkers.map((coworker) => coworker.id).sort();
const first = { team: null, runs: null, teamAt: null };

const tools = (code, { folder, operations, identity }) =>
	code.cloudHiringTools(identity, {
		folderHiring: new code.CloudFolderHiring({ folder, operations, identity }),
		folderGroupChats: new code.CloudFolderGroupChats({ folder, operations, identity }),
	});
const review = (code, { binding, paths }) =>
	new code.CloudActionReviewGate({
		binding,
		control: { call: (method, args, signal) => paths.call(method, args, signal) },
		reviewer: {
			review: async () => ({
				decision: "allow",
				ruleIds: [],
				builtIn: "none",
				reason: "The member asked for this team.",
				proposedRule: null,
			}),
		},
		request: REQUEST,
		holdMs: 0,
	});

const team = () =>
	proveCompanyRun({
		name: "qorpera_prove_hire_team",
		prompt: REQUEST,
		setup: "",
		objects: new Map(),
		tools,
		review,
		calls: [
			() => ({ name: "hire_team", arguments: TEAM }),
			(outputs, db) => {
				const receipt = JSON.parse(answerOf(outputs[0].output).text);
				assert.equal(receipt.outcome, "saved", JSON.stringify(receipt));
				first.team = receipt.hires.map((item) => item.id);
				first.teamAt = db.json(`select coalesce(jsonb_agg(distinct folder_commit_id), '[]')::text from public.qorpera_profile_staff
					where profile_id = '${PROFILE}' and staff_agent_id = any (array[${first.team.map((id) => `'${id}'`).join(",")}]::uuid[])`);
				first.runs = firstRuns(db, first.team);
				return { name: "hire_agent", arguments: NINTH };
			},
		],
		check: async ({ db, outputs, binding }) => {
			const [team, ninth] = outputs;
			assert.equal(team.envelope.status, "ok");
			const receipt = JSON.parse(team.text);
			assert.equal(receipt.hires.length, 8);
			assert(receipt.hires.every((item) => item.outcome === "saved"));
			assert(receipt.next.includes("each one's first run already lists the whole team as coworkers"), receipt.next);
			process.stdout.write(`hire_team's answer: ${team.bytes} bytes; next: ${receipt.next}\n`);
			const reviews = db.json(`select jsonb_agg(jsonb_build_object('tool', tool_name, 'effect', effect, 'decision', decision)
				order by created_at)::text from public.qorpera_action_reviews where run_id = '${binding.runId}'`);
			assert.deepEqual(reviews[0], { tool: "hire_team", effect: "delegation", decision: "allow" });
			const folderReviews = db.json(`select jsonb_agg(cardinality(units) order by created_at)::text from public.qorpera_folder_reviews
				where run_id = '${binding.runId}'`);
			assert.equal(folderReviews[0], 8);
			assert.equal(first.teamAt.length, 1);
			const commit = db.json(`select jsonb_build_object('id', id, 'units', jsonb_array_length(units), 'saved',
				(select count(*) from jsonb_array_elements(units) u where u ->> 'outcome' = 'saved'),
				'review', review_id is not null, 'receipt', receipt_id is not null)::text
				from public.qorpera_folder_commits where id = '${first.teamAt[0]}'`);
			assert.deepEqual(commit, { id: first.teamAt[0], units: 8, saved: 8, review: true, receipt: true });
			pass("one hire_team call: one review of the call (delegation), recorded for all eight new folders, one commit of eight saved units that indexed all eight agents");
			const after = db.query(`select (select min(r.created_at) from public.qorpera_session_turn_requests r
				join public.qorpera_agent_first_runs f on f.input_id = r.input_id
				where f.staff_agent_id = any (array[${first.team.map((id) => `'${id}'`).join(",")}]::uuid[]))
				>= (select created_at from public.qorpera_folder_commits where id = '${first.teamAt[0]}')`);
			assert.equal(after, "t", "every first run was queued after the team's one commit");
			assert.equal(first.runs.length, 8, `eight first runs: ${JSON.stringify(first.runs.map((run) => run.agent))}`);
			assert.deepEqual(first.runs.map((run) => run.agent).sort(), [...first.team].sort());
			for (const run of first.runs) {
				const expected = [...first.team.filter((id) => id !== run.agent), ...FIXTURE_AGENTS].sort();
				assert.deepEqual(coworkersOf(run.context), expected, `${run.agent}'s first context`);
				for (const id of first.team.filter((other) => other !== run.agent))
					assert(run.context.folder.coworkers[id], `${run.agent}'s first context names ${id}'s folder`);
				assert.equal(run.context.coworkersTruncated, false);
			}
			const readable = db.json(`select count(*)::text from public.qorpera_folder_entries e
				where e.environment_id = '${ENVIRONMENT}' and e.kind = 'file' and e.key_text in (${receipt.hires
					.map((item) => `public.qorpera_folder_key('${item.folder}/agent.md')`)
					.join(",")})`);
			assert.equal(readable, 8);
			pass("eight first runs, each started after the one commit; each first context lists the seven others, the hirer (Alice), the Co-Founder and the other agents, with their folders, and all eight agent.md files are in the folder");

			const later = JSON.parse(ninth.text);
			assert.equal(later.outcome, "saved", ninth.text);
			const [nine] = firstRuns(db, [later.agent.id]);
			assert(nine, "the later hire's first run");
			assert.deepEqual(coworkersOf(nine.context), [...first.team, ...FIXTURE_AGENTS].sort());
			pass("a later hire_agent: the ninth agent's first context lists all eight of the team, the hirer and the rest");

			const sponsor = db.query(`select binding.id from public.qorpera_execution_sponsor_bindings binding
				where binding.profile_id = '${PROFILE}' and binding.status = 'active' order by binding.created_at limit 1`);
			session(db, `select pg_temp.base_post('${OWNER}', '${BOB}', 'What changed in the team?', '${sponsor}')::text;`);
			const [next] = firstRuns(db, [BOB]);
			assert(next, "Bob's next run");
			assert.deepEqual(
				coworkersOf(next.context),
				[...first.team, ...FIXTURE_AGENTS.filter((id) => id !== BOB), later.agent.id].sort(),
			);
			pass("an agent hired before both (Bob): its next run lists the whole team and the later hire as coworkers, with no message sent to it");
		},
	});

const HOLDS = "name, role, jobDescription, firstAssignment and figure (figure is optional)";
const TOLD = [
	`INVALID_ARGUMENTS: hire 1: operationKey is given once for the whole call, never inside a hire. A hire holds ${HOLDS}`,
	"INVALID_ARGUMENTS: hire_team takes operationKey, once for the whole call, and hires, a list of 2 to 12 hires; it was given a key that is neither",
	"INVALID_ARGUMENTS: hire 2: role must be one line, with no line breaks",
	"INVALID_ARGUMENTS: hires must be a list of hire objects, not text holding one: send the list itself",
];
const SHAPES = [
	["a hire_agent-shaped key in every hire", { operationKey: "shape-1", hires: TEAM.hires.slice(0, 3).map((item, n) => ({ operationKey: `hire-${n}`, ...item })) }],
	["the hires under another key", { operationKey: "shape-2", team: TEAM.hires.slice(0, 3) }],
	["a role on two lines", { operationKey: "shape-3", hires: [TEAM.hires[0], { ...TEAM.hires[1], role: "Strategy\nand planning" }, TEAM.hires[2]] }],
	["the hires as one JSON text", { operationKey: "shape-4", hires: JSON.stringify(TEAM.hires.slice(0, 3)) }],
];
const corrected = (refused) => {
	const inside = /: (operationKey) is given once for the whole call, never inside a hire/.exec(refused)?.[1] ?? "";
	return {
		operationKey: "shape-1-again",
		hires: SHAPES[0][1].hires.map(({ [inside]: _, ...rest }) => rest),
	};
};

const refusals = () =>
	proveCompanyRun({
		name: "qorpera_prove_hire_team_refusals",
		prompt: REQUEST,
		setup: "",
		objects: new Map(),
		tools,
		review,
		calls: [
			...SHAPES.map(([, args]) => () => ({ name: "hire_team", arguments: args })),
			(outputs) => ({ name: "hire_team", arguments: corrected(answerOf(outputs[0].output).text) }),
		],
		check: async ({ outputs }) => {
			for (const [index, [shape]] of SHAPES.entries()) {
				const answer = outputs[index];
				process.stdout.write(`FACT ${shape}: ${answer.envelope.status} ${JSON.stringify(answer.text)}\n`);
				assert.equal(answer.envelope.status, "denied");
				assert.equal(answer.text, TOLD[index]);
			}
			const last = outputs[SHAPES.length];
			assert.equal(last.envelope.status, "ok", last.text);
			assert.equal(JSON.parse(last.text).outcome, "saved");
			pass("each wrong shape is refused with what is wrong, and the model corrects the call from the refusal's words alone");
		},
	});

finish(team().then(refusals));
