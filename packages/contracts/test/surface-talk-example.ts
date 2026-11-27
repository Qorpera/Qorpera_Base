const RIDERS = "post:research/riders.report.json";
const REPAIRS = "post:research/repairs.report.json";

export type Json = Record<string, unknown>;

export function exampleTalk(): Json {
	return {
		starter: "found",
		title: "What we found",
		sub: "What sixty riders and twelve repairs taught us about fixing bikes at the door.",
		question: "What do we know now that we did not know before?",
		answer:
			"Riders put repairs off because of the waiting and the trips, a repair is two hours of work, and three kinds of part cover most of them.",
		points: [
			{
				text: "Two riders in three ride on with a fault they know about, mostly for lack of time.",
				from: "What sixty riders told us",
			},
			{
				text: "A repair keeps the bike away five days for two hours of work.",
				from: "Twelve repairs we followed",
			},
			{
				text: "Brake pads, tubes and chains cover most repairs and fit in a van.",
				from: "Twelve repairs we followed",
			},
		],
		leftOut: [{ what: "What a visit should cost", goesTo: "What we do next" }],
		agreed: "2026-11-20",
		tone: "tint",
		whyThisLength: "Three findings, each with the pictures that show it.",
		listen: {
			day: "2026-11-21",
			heard: "Riders avoid repairs because of the waiting, and a van with three kinds of part could do most of them at the door.",
			lines: 17,
			marked: 1,
		},
		chapters: [
			{
				title: "Who needs a repair",
				points: [0],
				pictures: [
					{
						kind: "title",
						kicker: "What we found",
						title: "Repairs people put off",
						sub: "From sixty riders we asked",
						say: "This talk covers what we learned from sixty riders and four workshops. It starts with why people put a repair off.",
						from: [RIDERS],
					},
					{
						kind: "number",
						value: "41",
						label: "of 60 riders ride a faulty bike",
						sub: "Asked outside three stations in May",
						say: "We asked sixty riders outside three stations. Forty-one of them were riding a bike with a fault they already knew about.",
						from: [RIDERS],
					},
					{
						kind: "bars",
						title: "Why they wait",
						unit: "riders",
						items: [
							{ label: "No time", value: 23 },
							{ label: "Workshop too far", value: 11 },
							{ label: "Too dear", value: 5, dim: true },
							{ label: "Did not notice", value: 2, dim: true },
						],
						line: { value: 20, label: "Half of those waiting" },
						say: "Most of them wait because they have no time for the workshop. Distance comes second. Very few say the repair costs too much.",
						from: [RIDERS],
					},
					{
						kind: "ring",
						percent: 68,
						big: "68%",
						label: "ride on with a known fault",
						sub: "41 of the 60 we asked",
						say: "That is about two riders in three. The fault is known, and the bike is still on the road every day.",
						from: [RIDERS],
					},
				],
			},
			{
				title: "What a visit takes",
				points: [1],
				pictures: [
					{
						kind: "title",
						kicker: "The visit",
						title: "A repair takes one evening",
						say: "Next, what a repair costs the rider in time. We followed twelve repairs from the first call to the bike coming home.",
						from: [REPAIRS],
						tone: "paper",
					},
					{
						kind: "timeline",
						items: [
							{ when: "Day one", label: "Bike handed in" },
							{ when: "Day three", label: "Parts arrive" },
							{ when: "Day five", label: "Bike collected" },
						],
						say: "A normal repair kept the bike away for five days. Most of that time it stood waiting for a part.",
						from: [REPAIRS],
						tone: "paper",
					},
					{
						kind: "split",
						title: "Five days away",
						total: 120,
						unit: "hours",
						parts: [
							{ label: "Waiting for parts", value: 96 },
							{ label: "On the stand", value: 2 },
							{ label: "Waiting to be collected", value: 22 },
						],
						say: "Of the hundred and twenty hours, the mechanic worked on the bike for two. The rest was waiting, on a shelf.",
						from: [REPAIRS],
						tone: "paper",
					},
					{
						kind: "versus",
						left: {
							title: "At the workshop",
							big: "5 days",
							lines: ["Two trips by the rider", "Bike away all week"],
						},
						right: {
							title: "At your door",
							big: "1 evening",
							lines: ["No trip at all", "Bike never leaves home"],
						},
						verdict: "The work is the same two hours",
						say: "At the door the same two hours of work happen in one evening. The rider makes no trip and keeps the bike.",
						from: [REPAIRS, "plan"],
						tone: "paper",
					},
					{
						kind: "statement",
						text: "The work is short. The waiting is long.",
						sub: "That is the whole finding.",
						say: "So the thing riders avoid is the waiting and the trips. The repair itself was never the problem for them.",
						from: [RIDERS, REPAIRS],
						tone: "paper",
					},
				],
			},
			{
				title: "What it would take",
				points: [2],
				pictures: [
					{
						kind: "title",
						kicker: "Doing it",
						title: "What a van must carry",
						say: "Last, what it would take to do repairs at the door. We counted which parts the twelve repairs needed.",
						from: [REPAIRS],
						tone: "deep",
					},
					{
						kind: "marks",
						title: "Parts used in twelve repairs",
						items: [
							{ mark: "yes", label: "Brake pads", note: "Nine repairs" },
							{ mark: "yes", label: "Inner tubes", note: "Seven repairs" },
							{ mark: "part", label: "Chains", note: "Three sizes cover most" },
							{ mark: "no", label: "Wheels", note: "Too many kinds" },
							{ mark: "open", label: "Electric parts", note: "Not counted yet" },
						],
						say: "Brake pads and tubes cover most repairs, and a van can carry them. Wheels come in too many kinds. Electric parts we have not counted.",
						from: [REPAIRS],
						tone: "deep",
					},
					{
						kind: "matrix",
						cols: ["Fits a van", "Needed often", "Cheap to stock"],
						rows: [
							{ label: "Brake pads", cells: "yyy" },
							{ label: "Tubes", cells: "yyy" },
							{ label: "Chains", cells: "ypy" },
							{ label: "Wheels", cells: "npn" },
							{ label: "Us today", cells: "qqq", us: true },
						],
						say: "Three kinds of part fit a van, are needed often and are cheap to keep. That is enough for most of the repairs we followed.",
						from: [REPAIRS],
						tone: "deep",
					},
					{
						kind: "steps",
						items: [
							{ title: "Book", lines: ["Pick an evening"], state: "now" },
							{ title: "Repair", lines: ["At your door", "Two hours at most"], state: "next" },
							{ title: "Ride", lines: ["The same evening"], state: "later" },
						],
						say: "A visit would then run in three steps. The rider books an evening, the repair happens at the door, and they ride the same night.",
						from: ["plan"],
						tone: "brand",
					},
					{
						kind: "meter",
						title: "Repairs done on the first visit",
						unit: "%",
						max: 100,
						pass: { value: 80, label: "Worth doing" },
						stop: { value: 50, label: "Not worth it" },
						higherIsBetter: true,
						say: "It only works if most repairs are finished on the first visit. Eight in ten makes it worth doing. Under half does not.",
						from: ["bet:Most repairs finish on the first visit"],
						tone: "brand",
					},
					{
						kind: "quote",
						text: "I would pay just to skip the trip.",
						by: "A rider we asked",
						say: "One rider put it in a sentence, and several said much the same. The trip is what they would pay to avoid.",
						from: [RIDERS],
						tone: "brand",
					},
					{
						kind: "art",
						src: "talks/found/van.png",
						alt: "A small repair van with its side door open",
						say: "This is the kind of van we mean. It is small enough to stop in a courtyard, and it holds the three kinds of part.",
						from: ["yours"],
						tone: "stone",
					},
					{
						kind: "open",
						items: [
							{ label: "Electric bikes", needs: "A count of parts" },
							{ label: "Winter demand", needs: "A season of bookings" },
						],
						say: "Two things we could not find out by asking. How electric bikes change the parts, and whether riders book in winter.",
						from: ["unchecked:Winter bookings from a trade magazine"],
						tone: "stone",
					},
				],
			},
		],
	};
}
