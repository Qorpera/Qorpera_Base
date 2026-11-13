# Model kit: does it make money, and what moves it?

Draws the business in numbers: sliders, one big figure, a waterfall from what the customer pays to what is left,
and a curve of the month against volume with its break-even. Numbers not known yet are hatched sliders (and
provisional pictures) until the founder drags them or presses "Try an example".

Write `model.json`. Every number comes from the company's files. What is not known is `"unknown"`, never a guess.

- `lang` (such as "da"), `title` (≤40), `line` (≤60), `unit`: currency word (≤8, "kr"), `source`: optional `folder:` or
  `https:` link (↗).
- `words`: optional, the page's words in the company's language: `example`, `hint` ("{n}" = count), `hintLast`,
  `assumed`, `unknown`, `known`, `yours`, `provisional`, `reset`, `resetOne`, `breakEven`, `never`, `below`, `save`,
  `saving`, `saved`, `error`, `empty`.
- `groups`: up to 6 `{label (≤28), inputs: [...]}`, 16 inputs in all. An input:
  - `id` (letters, digits, `_`), `label` (≤28), `unit` (≤10), `min`, `max`, `step`.
  - `state`: `"known"` (a fact), `"assumed"` (someone's assumption), `"unknown"` (not known yet).
  - `value` for known and assumed. `start` for unknown: where the slider waits and what "Try an example" sets.
    A range and a start are not claims: pick a plain middle.
  - optional `note` (≤90, shown when the label is tapped), `source` link, `marks`: up to 6 reference points
    `{label (≤24), value (number or formula), note (≤40)}`, such as a competitor's public price.
  - A `%` input holds the number shown (8 means 8 %): write `retur / 100` in formulas.
- `computed`: `[{id, formula}]` over input ids, other computed ids, numbers, `+ - * / ( )`, `< > <= >= == !=`,
  `&& ||`, `min`, `max`, `round(x, digits)`, `abs`, `floor`, `ceil`, `clamp(x, lo, hi)`, `if(cond, a, b)`,
  `tiers(x, limit1, rate1, limit2, rate2, ..., rateRest)` for a stepped share. x/0 shows "–". A wrong name or a
  loop shows one quiet line.
- `headline`: `{value (id or formula), label (≤28), unit}`, the big figure. No `value`: what the flow leaves.
- `flow`: `{from: {label, value}, steps: [{label (≤22), value, state?}], result: label}`, up to 10 steps, each
  taken off (a negative step adds). Step labels: one or two short words.
- `curve`: `{x: input id, y: id or formula, label (≤28), unit: x's unit (≤12)}`, across x's whole range with the
  zero line and the break-even.
- `scenarios`: optional, up to 4 `{label (≤16), values: {id: number}}`: chips that move those sliders.
- `save`: optional `{table, key?, columns?}`: a button keeping the founder's numbers via `setRow(table, key, cells)`
  (with `key`: the row's key value, or `{column: value}` for a key of several columns) or `addRow(table, cells)`.
  Cells: `{id: number or null}` for the input and computed ids in `columns`, at most 12; with no `columns`, every
  input. A model of more than 12 inputs names its `columns`, or it has no save button.

Example:

```json
{"lang": "en", "title": "Unit economics", "line": "What one sale leaves", "unit": "$",
 "groups": [
  {"label": "Customer pays", "inputs": [{"id": "price", "label": "Price", "unit": "$", "min": 10, "max": 200,
   "step": 1, "start": 49, "state": "unknown", "marks": [{"label": "Rival A", "value": 79}]}]},
  {"label": "Costs", "inputs": [
   {"id": "cogs", "label": "Goods", "unit": "$", "min": 0, "max": 100, "step": 1, "value": 18, "state": "known"},
   {"id": "fee", "label": "Card fee", "unit": "%", "min": 0, "max": 5, "step": 0.1, "value": 2.9, "state": "assumed"}]},
  {"label": "Per month", "inputs": [
   {"id": "units", "label": "Units sold", "unit": "units", "min": 0, "max": 1000, "step": 10, "start": 200, "state": "unknown"},
   {"id": "fixed", "label": "Fixed costs", "unit": "$", "min": 0, "max": 20000, "step": 500, "start": 4000, "state": "unknown"}]}],
 "computed": [{"id": "fees", "formula": "price * fee / 100"}, {"id": "left", "formula": "price - fees - cogs"},
  {"id": "month", "formula": "units * left - fixed"}],
 "headline": {"value": "left", "label": "Left per sale"},
 "flow": {"from": {"label": "Customer pays", "value": "price"},
  "steps": [{"label": "Card fee", "value": "fees"}, {"label": "Goods", "value": "cogs"}], "result": "Left"},
 "curve": {"x": "units", "y": "month", "label": "Month's result"}}
```
