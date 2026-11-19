# Curve kit: where is it going?

Draws one value over time, big: money in the bank, orders a day, visitors a week. The past is a filled area under a
solid line. What is expected is a dotted line inside a band: the wider the band, the less sure. A line marks now, a
dashed line the safe level, and a few points carry a short mark. The value that matters stands large at the top; a
member runs a finger or the pointer along the curve and the big number follows. You write only `curve.json`.

## Fields

- `lang`: language code, such as `"da"`. `title` (40) and `line` (60): read only by screen readers; the page draws no title block.
- `unit` (8): the unit after the big number, such as `"kr"` or `"orders"`.
- `tone`: the curve's colour, `"accent"` (default), `"good"`, `"warn"` or `"bad"`.
- `points`: 2 to 120 in time order, each `{"label" (12), "value", "band"}`:
  - `label`: the time, such as `"Nov"` or `"Mon"`. Short: the page shows as many labels as fit.
  - `value`: a number. Leave it out when nobody knows it: the past then has a gap, the future a band only.
  - `band`: `[low, high]`, only for expected points: how far it may go each way. The page draws the band; never write
    about how unsure it is.
  - `state`: `"assumed"` for a value that is someone's assumption (drawn dashed).
- `now`: the `label` of the point that is now. Points after it are expected. Leave it out when every point is past.
  Expected points with neither value nor band are drawn as fog with a "?".
- `safe`: `{"value", "label" (24)}`, a level the value should stay above, such as the money that must stay in the bank.
- `marks`: up to 3 `{"at": label, "text" (24)}`, such as the low point. The page shows the value and the text there.
- `headline`: optional `{"value", "label" (24)}`: the big number when nobody points. Default: the value at now.
- `words`: the page's own words in your language: `now`, `safe`, `expected`, `assumed`, `unknown`, `between`
  ("{low} to {high}"), `empty`.
- `source`: an `https:` or `folder:` link to where the numbers come from. The page does not draw it.

A point's `value` and the `headline`'s may be live from a company database: `{"query": "<database>/<question>",
"params": {}, "column": "balance", "example": 62400}`. Known once it answers, else not known; `example` shows only
outside Qorpera.

## Rules

- Every number comes from the company's files or databases. Never invent one. An expected value is the company's
  own forecast, written down in its files; with none, leave the future out.
- Labels, not sentences. Texts over their limit are cut with "…". No colours or sizes: the page does that.

## Example

```json
{
  "lang": "en",
  "title": "Money ahead",
  "line": "In the bank, six months back and six ahead",
  "unit": "kr",
  "tone": "good",
  "points": [
    { "label": "Sep", "value": 37200 },
    { "label": "Oct", "value": 45600 },
    { "label": "Nov", "value": { "query": "bank/balance", "column": "balance", "example": 62400 } },
    { "label": "Dec", "value": 58000, "band": [52000, 65000] },
    { "label": "Jan", "value": 49000, "band": [40000, 58000] },
    { "label": "Feb", "value": 44000, "band": [33000, 55000] }
  ],
  "now": "Nov",
  "safe": { "value": 25000, "label": "safe level" },
  "marks": [{ "at": "Feb", "text": "low point" }],
  "source": "folder:finance/forecast.md"
}
```
