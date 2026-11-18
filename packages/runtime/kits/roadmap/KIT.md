# Roadmap kit: where is the whole ambition going?

Draws a wide mission as pictures of the world once each part of it is reached: the ambition's own picture with its
title, its products or fields as tiles under it, each opening into its goals (rising, numbered steps when they come in
order; the same height side by side), and a goal into the ideas tried for it. A member picks a picture to see it large,
and Open goes one layer down. You write only `roadmap.json`; the page finds each agent's figure by itself.

## Fields

- `lang`: language code, such as `"da"`.
- `title` (60): the ambition in a few words, drawn large over its `picture`. `caption` (90): one line under it.
- `parts`: 2 to 7, the products or fields the mission spans. `stand` and `kind` as a part's.
- A part:
  - `name` (48), drawn large when it is picked. `label` (28): the words on its tile, the name by default.
  - `caption` (90): one line. Without one the page names its own parts, or says it is not shaped yet.
  - `picture`: a `.png`, `.jpg` or `.webp` in the app's folder, such as `"pictures/well.png"`.
  - `state`: `"done"` (a check), `"now"` (its agents' figures), `"later"`, or `"open"`: still a question, dashed.
  - `agents`: 0 to 4 agents' names, the ones on it now; save_app adds `reading` to the app's reads.
  - `stand`: how its own parts stand, `"in order"` (steps, one after another) or `"side by side"` (the default).
  - `kind`: what one of its own parts is called, such as `"Goal"`: the page says "Goal 2 of 5".
  - `parts`: 1 to 12. Three layers under the title at most, 80 parts in all.
- `words`: the page's own words in your language (English and Danish are built in): `done`, `now`, `later`, `open`,
  `of`, `step`, `enter`, `noPicture`, `unshaped`, `where`, `parts`, `onIt`, `empty`.

## Rules

- Only for a mission wide enough to span several products or fields; one product's parts are a map. One roadmap per
  company, in `apps/roadmap`.
- Every part gets a picture of the world once that part is reached, made with `make_picture` at
  `apps/roadmap/pictures/<name>.png` before you save: real people and places, the day it is true. A part with none
  shows "No picture yet".
- A caption is one short line, and the picture carries the meaning. Labels, not sentences.
- No dates: the order of the list is the order. A part still in question is `open`, never a guess.
- Change it rarely: when a goal is reached, added or dropped. It is never a task list.
- The top layer's pictures come with the page; a deeper layer's load as a member opens it.

## Example

```json
{
  "lang": "en",
  "title": "Clean water in every home",
  "picture": "pictures/home.png",
  "stand": "side by side",
  "kind": "Field",
  "parts": [
    { "name": "Filters", "caption": "A filter any family can afford", "picture": "pictures/filter.png",
      "state": "now", "agents": ["Co-Founder"], "stand": "in order", "kind": "Goal",
      "parts": [
        { "name": "A filter a family can afford", "label": "A family filter", "picture": "pictures/family.png",
          "state": "now", "agents": ["Co-Founder"],
          "parts": [
            { "name": "A cartridge that lasts a year", "label": "A year's cartridge",
              "picture": "pictures/cartridge.png", "state": "now",
              "caption": "Done: the first design · Now: a hundred homes try it" },
            { "name": "Sold in village shops", "state": "open" }
          ] },
        { "name": "Every village has one", "label": "Every village", "state": "later" },
        { "name": "Cities switch to it", "label": "Cities switch", "state": "later" }
      ] },
    { "name": "Wells", "caption": "Water close to every door", "picture": "pictures/well.png", "state": "later",
      "stand": "in order", "kind": "Goal",
      "parts": [
        { "name": "A well dug in a day", "label": "A day's well", "state": "open",
          "caption": "A drill rig or hand tools: one of the two" }
      ] }
  ]
}
```
