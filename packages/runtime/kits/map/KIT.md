# Map kit: what are we making, and who is at it?

Draws the company, or your own area, as one picture: three to seven things, each a shape that fills from the bottom
as far as it is built or known, the agents' figures at the things they work on, and a mark where a thing waits for a
founder. A thing opens into a layer of what is being made inside it (a product into its parts), so a member can dive
in. You write only `map.json`; the page finds each agent's figure, and who works now, by itself.

## Fields

- `lang`: language code, such as `"da"`.
- `top`: the first layer. `"reading"` draws the company's own reading of itself (`QorperaOS/vision/reading.md`),
  live: the company's map, which the Co-Founder keeps; save_app adds `reading` to the app's reads. Or, for a map of
  your own area: `title` (40), `line` (60), `attention` (the id of the thing drawn biggest, in the middle) and
  `things`, 3 to 7.
- `layers`: what is inside a thing, by the thing's `id` (a reading's thing by its `key`): `line` (60) and `things`,
  1 to 12. A thing of a layer may have a layer of its own: four layers deep and 80 things in all at most. A thing
  with no layer does not open.
- A thing:
  - `id`: letters, digits, `-`. `name` (24). `shape`: board, box, screen, phone, gear, code, person, people, heart,
    pin, globe, chart, coin, bank, drop, megaphone, cart, handshake, truck, factory, scale, document, chat, wrench or
    blob.
  - `full`: 0 to 100, how much of it is built or known. Or `state`: `"unknown"` (a dashed outline with "?") or
    `"assumed"` (dashed and pale).
  - `note` (40): a few words under its name.
  - `agents`: 0 to 4 agents' names, the ones at work on it; drawn as their figures.
  - `waits`: `true` when it waits for a founder.
  - `seen`: the date you last looked at it, such as `"2026-11-15"`; past 14 days it is drawn pale with its age.
  - `opens`: `"app:<name>"`, another interface that shows the thing (its model, another owner's map).
  - `source`: an `https:` or `folder:` link.
- `words`: the page's own words in your language (English and Danish are built in): `finding`, `stood`,
  `notRight`, `draft`, `unknown`, `assumed`, `weeks`, `months`, `source`, `empty`, `tell`, `told`.

## Rules

- Only the company's real things. A layer holds what is being made inside its thing, never a list of tasks.
- Say `unknown`, or leave a thing out, instead of guessing. Set `seen` when you looked at a thing.
- A thing that has an interface of its own opens it (`opens`) instead of being drawn again here.
- Labels, not sentences; a text over its limit is cut with "…". Where things stand is the page's rule: the attended
  thing biggest in the middle, the others bigger the more agents work on them. On the company's map, "Not right?"
  under what changed lets a member send you a note.

## Example

```json
{
  "lang": "en",
  "top": {
    "title": "The repair tracker",
    "line": "What the product is made of",
    "attention": "app",
    "things": [
      { "id": "app", "name": "The tracker app", "shape": "phone", "full": 34, "note": "On paper",
        "agents": ["Product", "Engineering"], "seen": "2026-11-14" },
      { "id": "price", "name": "Its price", "shape": "coin", "full": 10, "note": "Waits for you", "waits": true },
      { "id": "costs", "name": "What it costs", "shape": "chart", "opens": "app:business-model" },
      { "id": "support", "name": "Support", "shape": "chat", "state": "unknown" }
    ]
  },
  "layers": {
    "app": {
      "line": "Its parts",
      "things": [
        { "id": "jobs", "name": "Job list", "shape": "board", "full": 60, "agents": ["Product"] },
        { "id": "sms", "name": "Text the customer", "shape": "chat", "state": "assumed", "note": "Wanted?" },
        { "id": "login", "name": "Sign-in", "shape": "code", "full": 80, "seen": "2026-10-20" }
      ]
    }
  }
}
```
