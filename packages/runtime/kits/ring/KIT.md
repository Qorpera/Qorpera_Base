# Ring kit: when is it?

Draws a year, a month or a week as one ring: its months or days round it, the part gone by a shade darker, a hand at
now. Marks are points in time (a deadline, a launch, a payday); wedges are stretches (a campaign, a holiday, a busy
season), and with amounts they reach out as far as their amount (sales a day round a week). The middle holds one big
thing: by default the next mark or wedge and how many days off it is, or a number you give. A member runs a finger or
the pointer round the ring, or the arrow keys, and the middle follows. You write only `ring.json`.

## Fields

- `lang`: language code, such as `"da"`. `title` (40) and `line` (60): read only by screen readers; the page draws no title block.
- `span`: `"year"` (default), `"month"` or `"week"`. `start`: its first day, `"YYYY-MM-DD"`, such as a business year
  from `"2026-07-01"`. Without it the ring is the calendar year, month or week (from Monday) of today.
- `marks`: up to 12, each `{"name" (24), "at": "YYYY-MM-DD"}`, such as a VAT date or a launch.
- `wedges`: up to 8, each `{"name" (24), "from": "YYYY-MM-DD", "to": "YYYY-MM-DD"}`, `to` included.
- On a mark or a wedge: `tone`, one of `"accent"`, `"good"`, `"warm"`, `"warn"`, `"bad"`, `"violet"`, `"teal"`
  (wedges without one take soft ones in turn); `value`, an amount the middle shows when it is picked (on a wedge it
  also sets how far the wedge reaches out); `state`: `"assumed"` (drawn dashed) or `"unknown"` (a hole with "?").
  What falls outside the ring's span is not drawn.
- `unit` (8): the unit after every amount, such as `"kr"`.
- `centre`: optional `{"value", "unit" (8), "label" (24)}`: a number for the middle when nobody points, such as the
  week's sales. Without it the middle shows the next thing.
- `now`: optional `"YYYY-MM-DD"` that holds the hand still on that day. Leave it out: the hand follows the clock.
- `words`: the page's own words in your language: `days`, `day`, `today`, `to` ("to {name}"), `left`
  ("left of {name}"), `ago` ("{n} days ago"), `assumed`, `unknown`, `empty`.
- `source`: an `https:` or `folder:` link to where the dates come from. The page does not draw it.

A `value` of a mark, a wedge or the `centre` may be live from a company database: `{"query":
"<database>/<question>", "params": {}, "column": "sales", "example": 3900}`. Known once it answers, else not known;
`example` shows only outside Qorpera.

## Rules

- Only real dates from the company's files: its deadlines, its plans, its seasons. Never invent one.
- Names, not sentences: the middle says the rest. A few things on a ring read best; 12 marks and 8 wedges at most.
- Texts over their limit are cut with "…". No colours or sizes beyond `tone`: the page does that.
- Look at it on a machine: the next thing should stand in the middle, and every mark should sit on its day.

## Example

```json
{
  "lang": "en",
  "title": "Our year",
  "line": "Deadlines and seasons of 2026",
  "span": "year",
  "unit": "kr",
  "marks": [
    { "name": "VAT return", "at": "2026-03-01", "tone": "warm" },
    { "name": "VAT return", "at": "2026-06-01", "tone": "warm" },
    { "name": "VAT return", "at": "2026-09-01", "tone": "warm" },
    { "name": "VAT return", "at": "2026-12-01", "tone": "warm",
      "value": { "query": "books/vat_due", "column": "amount", "example": 41800 } },
    { "name": "Lamp launch", "at": "2026-10-08", "tone": "good" }
  ],
  "wedges": [
    { "name": "Christmas season", "from": "2026-11-15", "to": "2026-12-24", "tone": "warm" },
    { "name": "Summer break", "from": "2026-07-06", "to": "2026-07-31", "tone": "teal" }
  ],
  "source": "folder:finance/deadlines.md"
}
```
