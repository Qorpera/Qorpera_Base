# Shelf kit: how do our things stand?

Shows the company's own things side by side on one shelf: its products, its parts, its finished work. Each is a big
picture with one level behind it, a soft colour block as high as the level, and the number that matters under it. A
low one turns warm. An agent's one-line note can sit on the thing that needs it. Without levels the shelf is a
gallery: finished things, framed, with the maker's figure. A member taps a thing to see it larger. You write only
`shelf.json`; the pictures lie in the app folder.

## Fields

- `lang`: language code, such as `"da"`. `title` (40) and `line` (60): read only by screen readers; the page draws no title block.
- `unit` (12): the unit after every thing's number, such as `"in stock"`. A thing's own `unit` wins.
- `things`: 1 to 8 (6 read best), each:
  - `id`: letters, digits, `-`. `name` (24). `picture`: a picture file of the app, such as
    `"pictures/desk-lamp.webp"`. A cut-out on a transparent background is best, all at the same scale.
  - `value`: the number that matters, such as 212; or a short text (14). Leave it out when nobody knows it.
  - `max`: the full level, such as the stock the store room takes: the block is `value` of `max` high. Or `level`:
    0 to 1 directly. With neither, the thing has no level (a gallery).
  - `low`: the number at or under which the thing is low, such as 20; or `true`. A low thing turns warm.
  - `state`: `"assumed"` (drawn dashed) or `"unknown"` (a hole with "?").
  - `note` (60): one line on the thing, such as "Order more?". `by` (24): who says it, or who made the thing.
    `figure`: that agent's figure: planet, acorn, flame, rocket, crown, heart, star, cloud, bolt, mushroom, moon
    or puzzle.
  - `colour`: `"good"`, `"accent"`, `"violet"`, `"teal"` or `"warn"`. Default: one after another.
  - `source`: an `https:` or `folder:` link, shown when the thing is open. `ask` (40): a draft for a note to you.
- `words`: the page's own words in your language: `low`, `assumed`, `unknown`, `close`, `source`, `empty`, `tell`, `told`.

A thing's `value` may be live from a company database: `{"query": "<database>/<question>", "params": {"sku": "desk"},
"column": "stock", "example": 212}`. Known once it answers, else not known; `example` shows only outside Qorpera.

## Rules

- Only the company's real things, with their real pictures. Every number comes from its files or databases.
- One note, two at most, on the things that need one. Labels, not sentences.
- Texts over their limit are cut with "…". No colours or sizes beyond `colour`: the page does that.

## Example

```json
{
  "lang": "en",
  "title": "Lamps in stock",
  "line": "What is on the shelf in the store room",
  "unit": "in stock",
  "words": { "tell": "Ask Mads", "told": "Sent to Mads" },
  "things": [
    { "id": "desk", "name": "Desk lamp", "picture": "pictures/desk-lamp.webp", "max": 240, "low": 20,
      "value": { "query": "shop/stock", "params": { "sku": "desk" }, "column": "stock", "example": 212 } },
    { "id": "mushroom", "name": "Mushroom lamp", "picture": "pictures/mushroom-lamp.webp", "value": 9, "max": 240,
      "low": 20, "note": "Order more?", "by": "Mads", "figure": "rocket", "ask": "Order 60 more" },
    { "id": "floor", "name": "Floor lamp", "picture": "pictures/floor-lamp.webp", "value": 64, "max": 240, "low": 20 }
  ]
}
```
