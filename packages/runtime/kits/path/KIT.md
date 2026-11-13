# Path kit: how does it go, and where is the hole?

Use it for a way through steps: a customer's way from need to purchase, a sales funnel, a supply route, a process
with a stuck step. Each group of people is a lane. Each step is a node. Evidence sits as dots under the step it
supports, with its count beside it. A step nobody has shown dissolves into fog with a "?". You write only
`path.json`. The page counts the evidence itself and shows the total and the weakest step as big numbers.

## Fields

- `lang`: language code, such as `"da"`.
- `title`: up to 40 characters. `line`: one quiet line, up to 60.
- `words`: the page's own words in your language: `known`, `assumed`, `unknown`, `total` ("in all"), `noMarks`,
  `close`, `next`, `empty`.
- `markWord`: what a mark is called, `{"one": "source", "many": "sources"}`.
- `steps`: 1 to 6 steps in order, `{"id", "name"}`. `name` up to 22 characters.
- `lanes`: 1 to 3 groups, each:
  - `id`, `name` (up to 22).
  - `figure`: a drawn picture: person, group, office, home, heart, cart, coin, headset, box, truck, chat, question,
    store, factory. Or `picture`: a picture file of the app, such as `"pictures/clinic.webp"`.
  - `steps`: `{stepId: {"state", "value", "note"}}`. Leave a step out and this lane skips it. Leave `steps` out and
    the page reads the states from the marks.
    - `state`: `known` (solid path), `assumed` (dashed, tagged), `unknown` (fog and "?").
    - `value`: a number, such as visitors. With numbers on two or more steps the path becomes a band
      to scale: a funnel. An unknown step has no value.
    - `note`: up to 90 characters. Shown when a member taps the step.
- `marks`: the evidence, one per source, interview, order or test:
  - `name` up to 40, `kind` up to 14. Common kinds get a small sign in the dot: statistik, myndighed, case, studie,
    historie, interview, anmeldelse, ordre, artikel, video, test, pris (or in English). Others show their
    first letter. Use the same kind word for the same kind of source.
  - `lane`: a lane id, or `"all"` when it supports every lane.
  - `step`: the furthest step it truly reaches. It counts for the steps before it too.
  - `source`: an `https:` or `folder:` link. Shown as a small ↗.
- `figures`: up to 3 numbers the data cannot give, `{"value", "label", "unit", "state"}`. `value` up to 10
  characters, `label` up to 28. Use `"state": "unknown"` for a number nobody knows: it shows "?".
- `next`: what will fill the hole, drawn as a small flag in it: `{"text", "step", "lane", "by"}`. `text` up to 60.
  `lane` is a lane id or `"all"`. `by` is the agent who does it.

## Rules

- Every fact must come from the company's files. Never invent a number, a source or a step's state.
- What nobody has shown is `unknown`. Do not write about it; the fog shows it.
- Texts longer than their limit are cut with "…". Write short labels, not sentences.
- No colours, sizes or layout: the page does that.

## Example

```json
{
  "lang": "en",
  "title": "The customers' way",
  "line": "What the sources show, and where they stop",
  "markWord": { "one": "source", "many": "sources" },
  "steps": [
    { "id": "need", "name": "Need better light" },
    { "id": "look", "name": "Look for a lamp" },
    { "id": "buy", "name": "Buy ours" }
  ],
  "lanes": [
    { "id": "homes", "name": "Homes", "figure": "home",
      "steps": {
        "need": { "state": "known" },
        "look": { "state": "known", "note": "Most start in a furniture shop." },
        "buy": { "state": "unknown" } } }
  ],
  "marks": [
    { "name": "Interview, a family of four", "kind": "interview", "lane": "homes", "step": "look",
      "source": "folder:research/interviews/family.md" }
  ],
  "next": { "text": "Ask ten buyers what they would pay", "step": "buy", "lane": "all", "by": "Ida" }
}
```
