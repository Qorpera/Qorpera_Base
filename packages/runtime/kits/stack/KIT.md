# Stack kit: what wants my yes?

Shows the things that wait on a member's yes, one big card at a time: a soft colour field or a picture, one big
number, one line, the asking agent's figure, and the answers as buttons under it. A press answers the question;
the card is stamped and the next comes forward. With nothing left the page says so. You write only `stack.json`.

## How the buttons work

A card's buttons are the options of an open question to the member that points at this app. Ask it with ask_member:
its title the card's `title`, word for word, a link `[title](app:<name>)` in its body, and options such as No,
Change, Yes. The last option is the big button. save_app gives the app the reads and writes this needs. A card
whose question is not open shows no buttons, only that it is not asked yet. When the member answers, you are woken
with the answer, as in the chat: act on it, then write `answer` into the card, or leave the card out.

## Fields

- `lang`: language code, such as `"da"`. `title` (40) and `line` (60): read only by screen readers; the page draws no title block.
- `cards`: up to 24 in order, the most urgent first. A card:
  - `id`: letters, digits, `-`. `title` (48): the question, such as "Pay the parts bill?".
  - `value`: the number that matters, such as 4200; or a short text (18), such as "Shop v2". `unit` (10): "kr".
  - `line` (60): one line under the number, such as "Due Friday".
  - `picture`: a picture file of the app, such as `"pictures/ad.webp"`, in place of the colour field.
  - `colour`: `"accent"`, `"good"`, `"violet"`, `"warn"`, `"teal"`, `"bad"` or `"plain"`. Default: one after another.
  - `by` (24): who asks, such as "Ida, brand". `figure`: that agent's figure: planet, acorn, flame, rocket, crown,
    heart, star, cloud, bolt, mushroom, moon or puzzle.
  - `paper: true`: drawn as a paper, such as a bill; `line` is then who it is from.
  - `question`: the open question's id, when its title is not the card's.
  - `answer`: what was answered, once it is: the card counts as done. `stamp` (16): the word stamped on the card.
  - `ask` (40): a draft for a note to you about the card.
- `total`: optional `{"value", "unit", "label" (24)}`, one figure beside the stack, such as what is owed in all.
- `words`: the page's own words in your language: `done` ("Nothing waits on you"), `answered` ("{n} answered"),
  `waiting` ("Not asked yet"), `saving`, `card` ("Card {n} of {total}"), `assumed`, `unknown`, `empty`, `tell`, `told`.

A card's `value` and the `total`'s may be live from a company database: `{"query": "<database>/<question>", "params":
{}, "column": "amount", "example": 4200}`. Known once it answers, else not known; `example` shows only outside Qorpera.

## Rules

- Every number comes from the company's files or databases. Never invent one.
- One card is one decision. Labels, not sentences: the reasoning stays in its file.
- Texts over their limit are cut with "…". No colours or sizes beyond `colour`: the page does that.

## Example

```json
{
  "lang": "en",
  "title": "Wants your yes",
  "line": "Things the team waits on",
  "words": { "done": "All signed", "tell": "Ask Ida", "told": "Sent to Ida" },
  "cards": [
    { "id": "ad", "title": "Run this ad?", "value": 1500, "unit": "kr", "line": "7 days on Instagram",
      "picture": "pictures/ad.webp", "by": "Ida, brand", "figure": "star", "ask": "Make it warmer" },
    { "id": "parts", "title": "Pay the parts bill?", "value": 4200, "unit": "kr", "line": "Due Friday",
      "colour": "accent", "by": "Mads, shipping", "figure": "rocket" },
    { "id": "vat", "title": "Send the VAT return?", "value": 3120, "unit": "kr", "line": "Due 1 December",
      "colour": "good", "by": "Co-Founder", "figure": "crown", "answer": "Send" }
  ]
}
```
