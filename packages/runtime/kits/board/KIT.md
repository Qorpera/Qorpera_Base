# Board kit: what is out there, and which one?

Shows real things as pictures to compare or choose between. You write `board.json`; the pictures and videos lie in the
app folder and are named by their path, such as `pictures/a.webp`. Text over its limit (in brackets) is cut.

## Top level

- `lang`: language code, such as `"da"`. `mode`: `"scale"`, `"choose"` or `"wall"`.
- `title` (40) and `line` (60): the page's name and one quiet line. No other text on the page.
- `words`: the page's own words in your language. Keys: `assumed`, `unknown`, `notKnown`, `all`, `close`, `source`,
  `choose`, `recommended`, `chosen`, `saving`, `back`, `colours`, `type`, `film`, `previous`, `next`, `keep`, `drop`, `empty`,
  `tell`, `told`.
- `items`: the things. Every item has `id` and `name` (28).

## scale: things on one true scale (a shelf)

- `axis`: `{"label" (36), "unit" (10), "min", "max"}`. Or a list of up to 3, each with an `id`: one shelf each.
  Prices in different currencies get one shelf each. Never convert with a rate you made up.
- Item: `picture` (a cut-out on a transparent background is best), `value` (a number on the axis), `valueText` (20,
  the value as written, such as `"249,99 USD"`), `state` (`"known"`, `"assumed"`: placed by an assumption, drawn
  dashed), `axis` (the id of its shelf), `group`, `tags` (up to 3, each 16), `facts` (up to 5, each
  `["label" (18), "value" (22)]`; a fact with no value is drawn as unknown), `note` (90: one sentence, shown when the
  member opens the item), `source` (`"https://…"` or `"folder:…"`).
- An item with no `value` stands in a dashed bay marked `?`. Leave a value out rather than guess it.
- `groups`: `[{"id", "name" (24), "route": ["Maker", "Us", "Customer"]}]`. Chips pick out a group's items. A route
  (2 to 4 stops, each 14) is drawn as a line a parcel travels along.

## choose: two to four directions to pick from

- One panel per item, in its own colours. The page draws no title block: `title` and `line` are read only by screen
  readers, so put nothing there a member must see.
- When every item has a `poster` or a `video`, the pictures are the page: each as large as the screen allows, side by
  side or stacked, with the logo, name and line small under it. Give every item one, in the same shape, and make it
  show the direction itself. Without them, the panel shows the logo and name large.
- Item: `line` (60), `logo`, `background` (hex), `palette` (up to 5
  `{"name" (16), "hex"}`), `poster` (a 16:10 still), `video` (mp4, plays muted on hover), `gallery` (up to 8
  `{"src", "caption" (18)}`), `type` (`{"name", "family": a CSS font stack of fonts the device has, "sample" (44)}`),
  `recommended: true` (one item only), `by` (24, who recommends it), `source`.
- The choose button answers your open question for this app. Its options' values must be the items' ids (or give the
  question's id in `question`). With no open question there is no button. `chosen`: the id of an item already chosen.

## wall: reference pictures

- Item: `picture`, `note` (90), `mark` (`"keep"` or `"drop"`), `source`.

## Example

```json
{
  "lang": "en", "mode": "scale",
  "title": "Lamps on the market", "line": "Public prices · USD and EUR are not converted",
  "words": { "notKnown": "Price not known", "all": "All" },
  "axis": [
    { "id": "usd", "label": "US shop", "unit": "USD", "min": 0, "max": 200 },
    { "id": "eur", "label": "incl. VAT", "unit": "EUR", "min": 0, "max": 200 }
  ],
  "groups": [{ "id": "ready", "name": "Ready-made", "route": ["Maker", "Us", "Customer"] }],
  "items": [
    { "id": "arc", "name": "Arc One", "picture": "pictures/arc-one.webp", "axis": "usd",
      "value": 129, "valueText": "129 USD", "group": "ready", "tags": ["LED"],
      "facts": [["Warranty", "2 years"], ["Price in Denmark"]],
      "note": "Sold direct, no dealers yet.", "source": "folder:research/market.md" },
    { "id": "halo", "name": "Halo", "picture": "pictures/halo.webp", "axis": "eur",
      "value": 89, "valueText": "89 EUR" },
    { "id": "nord", "name": "Nord", "picture": "pictures/nord.webp" }
  ]
}
```
