# Flow kit: where does it come from, and where does it go?

Draws money or people as a river: wide soft bands from where they come, on the left, through the company, a bar in the
middle, to where they go, on the right. Every band is as wide as its amount. With `links` the bands run straight from
each source to each end instead, such as visitors from each place to bought or left. One big number stands at the top,
by default all that came in; a member points at a band, or steps with the arrow keys, and the number becomes that
band's, with its share. You write only `flow.json`.

## Fields

- `lang`: language code, such as `"da"`. `title` (40) and `line` (60): the page's name and one quiet line.
- `unit` (8): the unit after every amount, such as `"kr"` or `"people"`.
- `from`: where it comes from, 1 to 6, each `{"id", "name" (20), "value"}`: `id` letters, digits, `-`; `value` the
  amount, 0 or more. Leave `value` out when nobody knows it: the band is drawn open with "?".
- `to`: where it goes, 1 to 6, the same; `"kept": true` on what the company keeps (drawn last, in green).
- On an end: `tone`, one of `"good"`, `"warm"`, `"accent"`, `"warn"`, `"bad"`, `"violet"`, `"teal"` (default: green
  in, warm out); `state`: `"assumed"` (drawn dashed).
- More than 6 on a side: the page keeps the largest and joins the rest into one band, `words.other`.
- `middle`: the name under the middle bar, such as the company's or `"Bank"`. Ends of `from` flow into it and out to
  `to`; the two sides need not add up to the same.
- `links`: optional, up to 24 `{"from": id, "to": id, "value"}`: bands straight from an end of `from` to one of `to`,
  with no middle. The ends' amounts are then what their bands carry, and their own `value` is not read.
- `headline`: optional `{"value", "label" (24)}`: the big number when nobody points, such as what was kept.
- `words`: the page's own words in your language: `total` (the big number's label, "in all"), `other`, `assumed`,
  `unknown`, `empty`.
- `source`: an `https:` or `folder:` link to where the numbers come from (a small ↗).

A `value` of an end, a link or the `headline` may be live from a company database: `{"query": "<database>/<question>",
"params": {"month": "2026-11"}, "column": "amount", "example": 182000}`. Known once it answers, else not known;
`example` shows only outside Qorpera.

## Rules

- Every amount comes from the company's books, bank or databases, all of one span (a month, a year). Never invent one.
- Few bands: three or four on a side read best. Name each in a word or two.
- Texts over their limit are cut with "…". No colours or sizes beyond `tone`: the page does that.
- Look at it on a machine at 390 px wide too: every name should stand clear beside its band.

## Example

```json
{
  "lang": "en",
  "title": "Money in November",
  "line": "From sales to what it paid for",
  "unit": "kr",
  "middle": "Bank",
  "from": [
    { "id": "shop", "name": "Web shop",
      "value": { "query": "bank/money_in", "params": { "kind": "sales" }, "column": "amount", "example": 182400 } },
    { "id": "retail", "name": "Retailers", "value": 64200 }
  ],
  "to": [
    { "id": "parts", "name": "Parts", "value": 71800 },
    { "id": "salaries", "name": "Salaries", "value": 92000 },
    { "id": "ads", "name": "Ads", "value": 24600 },
    { "id": "tax", "name": "VAT and tax", "value": 31500 },
    { "id": "kept", "name": "Kept", "value": 26700, "kept": true }
  ],
  "source": "folder:finance/november.md"
}
```
