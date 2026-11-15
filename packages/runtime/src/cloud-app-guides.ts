/*
 * The guides of an interface app's parts (deploy/first-node/RUNTIME-INTERFACE-APPS.md §3d): the look every app is
 * held to, what a kit's one file holds, how a page written by hand is styled, how it reads the company's live data and
 * lets a member act, and how an app's own icons are drawn. An agent reads one with `app_guide` before it makes that
 * part, and save_app saves a kit's file only in a run that has read the kit's guide (cloud-folder-app-tools.ts).
 *
 * Until 14 November 2026 these were the descriptions of save_app's fields, about 40 KB of them, and no agent ever read
 * one: the patched Codex sends no field description of a tool whose schema is 5,000 bytes or more as it sends it
 * (probed that day: 4,991 bytes kept them, 5,000 lost every one), so save_app's schema reached the model as its bare
 * shape. The kits, live since v243, were filled from their names: the one model app a company had held
 * `{"groups":[]}`, an agent's answer to "model.json has no groups". A guide is a tool's answer now, read when the part
 * is made, and save_app's fields say a line each, under that bound like every other tool's.
 */

import { APP_ICONS_FOLDER, APP_ICONS_MAX } from "@qorpera/cloud-client/app-icons";
import { isDataKit, KIT_GUIDE } from "./cloud-app-kits.ts";

/** What app_guide tells of: the look every app is held to, each kit by its name, then the parts of a page written by
 * hand, then an app's own icons. */
export const APP_GUIDES = [
	"look",
	"model",
	"board",
	"path",
	"object",
	"curve",
	"stack",
	"shelf",
	"map",
	"explainer",
	"style",
	"reads",
	"writes",
	"icons",
] as const;
export type AppGuide = (typeof APP_GUIDES)[number];
export const isAppGuide = (value: unknown): value is AppGuide =>
	typeof value === "string" && (APP_GUIDES as readonly string[]).includes(value);

/**
 * What save_app's `kit` says: which kit draws which thing (RUNTIME-INTERFACE-APPS.md §3a and §3b). It is the one part
 * of the kits an agent needs before it chooses, so it stays on the field; what the chosen kit's file holds is its guide.
 */
export const APP_KIT_CHOICE =
	"The form Qorpera draws for you, or null for a page you write by hand (the product's own prototype, or a working tool no kit draws). Before your first app, read app_guide look. Choose by what the thing is. model: how something works in numbers, such as a business model, a price, costs or capacity. board: real things as pictures, such as a market's products on one scale, directions to choose between, or a wall of references. path: a way through steps with the evidence for each, such as customers from need to purchase, a funnel or a supply route. object: a physical thing a member turns in the hand. curve: one value over time, such as money in the bank or orders a day, the past and what is expected. stack: things that want a member's yes, one card each, such as bills to pay or ads to run. shelf: the company's own things side by side, each with one level, such as products and their stock. map: the company or your own area as its things, which fill as they are built, with the agents at them and layers to open, such as the company's map or a product's parts. explainer: a mechanism or a decision that a short narrated video explains.";

/**
 * The look every app is held to (Jonas, 14 November 2026, after 44 sketched screens of a company: he liked a few and
 * not the rest). The rules are his taste in
 * short words; the screens are the ones he liked and three he did not, each told in one line, since no picture of them
 * reaches every company's folder yet. They show the bar, not the screens to make: "it would still be important that the
 * agents knew to diverge from them and create whatever the company needed".
 */
const LOOK = `Read this before your first app. It is the bar every app is held to, whatever it shows.

- Qorpera's own plain look: the base style's page (--q-bg) and the system font, never colours of your own for the page. No scenes, skies, landscapes or themed backdrops.
- Show the company's real things: its products, its shop, its money, its dates, its customers' own words.
- One big shape owns each screen: a ring, a curve, a big card, a big window, a shelf of real things. Colour comes as large, soft fields. Use very few words.
- Never a grid of small controls, rows of little chips or pills, scattered dots, cards of text, or diagram lines with labels.
- Copy the quality, not the layout. The screens below show the bar; they are not screens to make. Build what this company needs, in the shape that shows it best.
- A kit draws its own form, sliders, chips and arrows included: for a kit, this decides what you put in it (real things, few words, the numbers that matter). For a page you write by hand, it decides the page too.
- Some apps are views the company is owed, which members find first: apps/products (what it sells), apps/money (its money), apps/ads (its ads). Make one when asked, at exactly that folder; the platform draws the website itself.

Screens at the bar:
- While you slept: three big numbers of the night (orders, money in, new customers), what each agent did in a word or two, and one button for the two things that want a yes.
- Money as a river: the month's money flows from where it came (the shop, wholesale) to where it went (parts, shipping, ads) and to what was kept, under how many months the money lasts.
- Sign-off: the things that want a yes as a stack of big cards, one at a time, each with one picture, one amount and Yes, Change or No.
- Replay the day: one line through the day with the agents on it; a tap shows that moment large.
- The year ring: the company's duties as one ring of twelve months, with the next deadline in its middle.
- The week's forecast: seven tall tiles, one a day, each a soft colour with a few words, and one action under them.
- The shop live: the real shop, large, with warm glows where people are and how many are here now.

Not this:
- A grid of small dials and gauges, a row for each agent: many small controls and no one shape.
- Customers as dots scattered in rings: nothing to take in at a glance.
- The team as a house lit up at night: a themed scene in place of the company's real things.`;

/**
 * How a page reads the company's live data (the bridge of RUNTIME-INTERFACE-APPS.md §5, which no agent-made app had
 * used by 10 November 2026: every page was typed in by hand and went stale when its area moved on). The pace it sets
 * keeps a page inside the bridge's budget (120 a minute, todos as ten; change notices up to once a second): six draws
 * a minute of todos, agents and a few files stay under it, and a page that redrew on every notice would spend it in
 * seconds and then show an error until the next change.
 */
const READS =
	"manifest.reads names the live sources a page may read. The page's script reads the company through the qorpera object, and every call returns a promise. qorpera.read(path) gives a file's text and qorpera.list(folder) a folder's entries (name, path, kind, bytes, updatedAt), both by company path, such as apps/<name>/state.json: the app's own folder always, any other company path only with files in reads. qorpera.table(name) gives {name, columns, rows}, each row an object by column name (tables in reads). qorpera.todos() gives every agent's todos as {agent, title, status, updatedAt}, with status open, blocked, done or cancelled (todos in reads). qorpera.agents() gives each agent's name, role and working, true while it works (agents in reads). qorpera.questions() gives your and the other agents' open questions to this member that point at this app (questions in reads; app_guide writes says how a page answers one). qorpera.onChange(fn) calls fn when the company folder changed, which in a busy company is every few seconds. Read and draw when the page opens; after a change draw again once, no sooner than ten seconds after the last draw however many changes arrive, and do not poll on a timer. An app may make 120 calls a minute in a member's tab and 8 at a time, and todos counts as ten calls, so call each source once per draw. Keep the facts a page shows (decisions, numbers, open questions) in one data file in the app's folder and draw the page from it, so a change of state is a change to that one file; show who works on what and what is blocked from todos and agents instead of typing it in. When a read fails, keep what the page last showed and read again ten seconds later, until a read works; with nothing to show yet, show a plain line, never an empty page. Reading changes nothing: app_guide writes says what a page may ask a member to change.";

/**
 * How a page lets a member act on the company (RUNTIME-INTERFACE-APPS.md §5; Jonas, 10 November 2026: "interfaces
 * let's you interact with your company directly"). The page only asks: the web draws a bar outside the app's frame
 * that shows what will be saved, and the save is the member's own.
 */
const WRITES =
	"manifest.writes names what a page may ask a member to change, of answers and table:<name>. A page changes nothing by itself: its script asks, Qorpera shows the member a bar above the page with exactly what will be saved, and it is saved only when the member allows it there, as the member's own change. Each call returns a promise: it resolves once the change is saved, and rejects with the reason when the member says not now, when another request still waits, or when the save is refused. Show that reason on the page and leave the button, so the member can try again. Ask only from a click on a button of the page that says what it does, one request per click, never when the page opens or on a timer: after three not now in a row the page may not ask again until the member reloads it. A <form> does not submit inside an app: handle the button's click (and Enter in a field), not a form's submit. answers: a member answers an open question on the page. Ask the question with ask_member and point it at the app, with a link [title](app:<name>) in its body or app:<name> as an option's preview. qorpera.questions() (questions in reads) then lists the open questions that point at this app, each {id, agent, title, body, options: [{label, value, description}], multiSelect, askedAt}. Draw them as part of the page: a choice between two concepts as a button on each concept, an approval as a button beside what is approved. On a click call qorpera.answer(id, value) with one option's value, or a list of values for a multiSelect question. Your run goes on with the answer, as when the member answers in the chat; a typed answer is given in the chat. table:<name>: a member changes a row of the company table QorperaOS/tables/<name>/, such as a status, a date, a number or a note. qorpera.setRow(table, key, cells) changes cells of the row with that key: key is the value of the table's key column (an object of column to value when the key is several columns), and cells is an object of column to new value: text, a number, true or false, or null to empty an optional cell. qorpera.addRow(table, cells) adds a row. One row per request, at most 12 cells of it, a cell's text at most 500 characters; the bar shows each value before and after. A page cannot change a key cell or a column that names a member or an agent, and cannot remove a row; the table's own [write] rule and column types still decide, and the table areas is never written from an app. Read the rows with qorpera.table(name) (tables in reads) and draw again after a change. To act when a member changes a row, set a routine that wakes you: manage_routine with a trigger of kind file_change and path QorperaOS/tables/<name>/rows.csv; without one you see the change the next time you read the table. Keep what members change in a table, and what only you change in a data file of the app.";

/**
 * The base style every app's page starts from (RUNTIME-INTERFACE-APPS.md §2; the web puts it into the page,
 * packages/web/src/app/interface-app-style.ts): its variables, where the company's colours come from, and how a page
 * follows light and dark.
 */
const STYLE =
	"Each page starts from Qorpera's base style, which sits in a layer under your own CSS, so any rule you write wins over it: the system font, the text in a centred column at most 800 px wide (set body's margin yourself to use the whole width), and plain headings, links, tables and code. Its colours are CSS variables, and you use them in place of fixed colours: --q-bg the page, --q-text the text, --q-muted quiet text, --q-line rules and borders, --q-surface cards and panels, --q-accent the company's colour for links, marks and key figures, --q-on-accent text on the accent, --q-accent-soft a tint of it, and --q-good, --q-warn and --q-bad for states; --q-font and --q-mono are the type and --q-radius the corner. They hold the company's colours once QorperaOS/brand/brand.toml gives them, which the agent that owns the brand writes with company_write: accent, background and text, each as \"#rrggbb\", at the top for a light page and again under [dark] for a dark one. Text must read on its background (4.5 to 1) and the accent must show on it (3 to 1), or Qorpera's own colour is used instead. A page is shown light unless its head says it works in both, with <meta name=\"color-scheme\" content=\"light dark\">: then it follows the member's light or dark, so give it no fixed colours at all. The company's logo and other pictures are still copied into the app's folder, because a page cannot read QorperaOS/. A concept gets no base style.";

/**
 * An app's own icons (Jonas, 12 November 2026: "change the icons of the interfaces and have a generate icon button too
 * for them to create a new custom one based on it's name or contents"). A member's Generate icon in the apps drawer
 * asks the app's maker in the chat for 3; the format is the one `parseAppIcon` reads (@qorpera/cloud-client/app-icons),
 * to which save_app holds each icon of a call. company_read shows an SVG as text, so the agent sees one only in a
 * machine's screenshot.
 */
const ICONS = `An app's own icons are files ${APP_ICONS_FOLDER}/<id>.svg, the id one or two words for what it shows, such as compass or trail-sign: any member may pick one for the app under Icon and colour in its menu in the apps drawer. When a member asks you for new icons for an app, draw 3 clearly different ones from its name and what its page shows, and save them in one call with manifest null and only the icons in files: an ask for icons never changes manifest.emblem. Draw each as Qorpera's own emblems are drawn: <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"> holding one bold, solid shape filled black (#000), which takes the app's colour, with its details cut out in white (#fff): white shapes, or white lines of stroke-width 2.6 to 3.4 with stroke-linecap round. Use only path, circle, rect, ellipse, line, polyline and polygon, with fill and stroke black, white or none, and nothing else: no transform, style, class, text, group or gradient. Keep to a few large parts, so it still reads at 34 px. An app keeps at most ${APP_ICONS_MAX}: to draw more, give a new one the id of an old one it replaces. company_read shows an .svg as its text, not as a picture: when machine_run is offered, look at them in a browser on a machine, small and large, as you look at a page, and draw again one that does not read. Then tell the member in one line what you drew, and that they pick one under Icon and colour in the app's menu in the apps drawer.`;

/**
 * The explainer kit: how to make a short narrated video in place of a page (RUNTIME-INTERFACE-APPS.md §3a; Jonas,
 * 10 November 2026). It is the whole of what an agent knows of the engine (packages/runtime/kits/explainer/engine.js),
 * so a name here that the engine lacks draws nothing: the kit's test holds the two together.
 */
const EXPLAINER =
	'explainer makes the app a short narrated video in place of a page: 90 to 120 seconds that explain one mechanism, decision or idea with pictures that move, as a maths explainer does. Use it where motion explains better than a page: how money or data flows, why a number is what it is, what a choice costs. Not for a thing a member should handle (that is another kit) and not as a mock-up of a screen. You write one file, scenes.js; save_app writes engine.js and index.html beside it, so never write or edit those two. scenes.js adds chapters and scenes to the video V, which the page makes and starts: V.part("The idea"); V.scene((s) => { const a = s.box({x: 400, y: 450, w: 260, h: 100, label: "Shop", sub: "pays 149", color: C.blue}); const b = s.icon({name: "person", x: 1100, y: 450, color: C.yellow, label: "Ada"}); const ab = s.arrow(a, b, {color: C.yellow}); s.say("The shop pays Ada.", s.create(a), s.create(b), s.create(ab), s.flow(ab, 1.2, {count: 3})); }); A part is a chapter (4 to 6 in a video); a scene is one picture, and the stage clears between scenes. The stage is 1600 by 900: x and y are a thing\'s centre, y grows downwards. Things: s.box({x, y, w, h, label, sub, color, dash}); s.text({x, y, str, size, color, font: "sans" or "serif"}); s.number({x, y, from, size, fmt}), which s.value(n, to) counts; s.bar({x, y, w, h, dir: "up" or "right", scale}), which s.value(bar, to) grows; s.icon({name, x, y, label}) with name of person, bot, house, bus, card, coin, server, db, cloud, lock, doc, clock, shield, globe, mail, bolt; s.arrow(from, to, {color, bend, label}) between two things or points; s.line({d, head: false}) for any path. show: true on a thing makes it visible from the start: for the title frame only. s.say(caption, ...animations) is one caption and what moves under it, one after another: s.create(m) draws it, s.write(text), s.fadeIn(m), s.fadeOut(m), s.dim(m, 0.3), s.move(m, x, y), s.scale(m, k), s.indicate(m) glows, s.value(m, to), s.flow(arrow, seconds, {count}) sends dots along an arrow, s.camera(x, y, zoom). Each takes its seconds last; s.all(s.create, [a, b], 1) runs several together and {w: true} plays one with the one before it. Animate every thing: what you never animate just fades in. Colours come from C, one meaning each: yellow money, green what is kept or good, red loss, blue and teal things, purple partners, grey what is unknown. The captions are the narration: shown under the stage, and spoken word for word when the video has a voice. Write them for the ear: one idea and about 15 words a caption, short plain sentences, amounts as they are said (149 kroner, not NOK 149.00), no brackets and no symbols. 2 to 7 captions a scene, 25 to 35 in all. The stage shows and the caption tells: at most 12 words on the stage at once, and never a sentence in a box. A mechanism is motion: money flows along arrows, a total counts up or down, a part slides out of a whole, a bar grows past zero; never only boxes that appear. Keep 60 units free at every edge. Text sizes: 24 at least, 28 to 34 for labels, 44 to 60 for statements, 76 to 96 for the one number that matters. The first scene is the title frame: a small grey line, the title in two lines at size 70 to 80 and one small picture, all show: true, with the band around y 560 left free for the Play button. The last scene stays on screen at the end: make it a summary worth stopping on. Every number, name and claim comes from the company\'s files: never round a figure into a new one, and say assumed or example where the source does. Look before you show it, as for any app, and at more than the first frame: index.html?t=SECONDS opens the video paused at that second. Look at the end of each caption, at t=0 and at the last frame, at 1280 and at 390 px wide, and fix what overlaps, is cut off, stands empty or is too small to read. The answer\'s look names what a read of scenes.js found.';

/**
 * What the data kits have in common (RUNTIME-INTERFACE-APPS.md §3b): one data file, the pictures in the folder
 * before the save, labels and not sentences, unknown drawn and never written about. Each data kit's guide starts with
 * it, then gives the kit's own (packages/runtime/kits/<kit>/KIT.md, which reaches a run in the same bundle as its
 * engine).
 */
const DATA_KITS_SHARE =
	"For a data kit (model, board, path, object, curve, stack, shelf, map) you write one file among files, the kit's data (<kit>.json, such as model.json), and save_app writes engine.js and index.html: never write or edit those two. A picture or video the data names shows only when it is in the app's folder as you save: write it there first (on a machine, under /company/apps/<name>/), or save the data again after. Change the data with save_app, not with company_write, so the page is written again with it. The page speaks your data's language: give lang, and the kit's words in that language. Every kit's words may hold tell, the label of the button with which a member sends you a note about the thing they opened, naming you (\"Ask Luna\"), and told, what it says once the note went; a thing a member opens (a board's item, a path lane's step, an object's part, a model's input, a shelf's thing) may hold ask, a draft for that note (≤40 characters). Such a note reaches you as the member's message, under a first line that names the app and the thing. Every text in the data is a label or a note of one line, and the page cuts what is longer. Every fact comes from the company's files; what nobody knows yet is marked unknown, which the page draws as open: never guess it and never write about it. Look at the app on a machine before you show it, as for any app: its index.html opens there with the data you saved. The answer's look names the pictures the folder lacks and the texts the page cuts.";

/** One guide's text, as app_guide answers it: the whole of what an agent knows of that part. */
export function appGuide(about: AppGuide): string {
	if (isDataKit(about)) return `${DATA_KITS_SHARE}\n\n${KIT_GUIDE[about].trim()}`;
	switch (about) {
		case "look":
			return `# The look of an app\n\n${LOOK}`;
		case "explainer":
			return `# Explainer kit: why is it so?\n\n${EXPLAINER}`;
		case "style":
			return `# The base style of a page written by hand\n\n${STYLE}`;
		case "reads":
			return `# How a page reads the company's live data\n\n${READS}`;
		case "writes":
			return `# How a page lets a member act\n\n${WRITES}`;
		case "icons":
			return `# An app's own icons\n\n${ICONS}`;
	}
}
