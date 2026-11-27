---
name: talks
description: How to make a talk: a short narrated presentation the founders watch, one question answered in pictures. Use before you propose, write or change a talk.
---

# Talks

A talk is chapters of pictures, each with one spoken line shown as its caption. Skip no step below.

## The seven rules
1. One question, one the listener has. Before any picture, write its answer in one sentence and three to seven points that, said in order, already answer it. No answer from what is known: stop, and say what is missing and who has it.
2. Each talk has borders, fixed below. What belongs to another talk gets one sentence naming it, or nothing.
3. The reason comes from the founders. Facts come from research posts, the plan and the bets. Why the company exists, what it believes and who it is for come from the founders' own words: the company's vision, read whole, then what they have said since. What is in neither, you ask. Never write your own reading of a reason, not even as a draft to confirm, nor fill the gap with features, rivals or tests. Use their words unchanged.
4. Spoken for someone who never opened this page. No code numbers: a bet is called by what it claims. No page or tab names, no "the Strategy says", no name the listener was not told in this talk. Where a line rests is a mark on the picture, never spoken.
5. Everything earns its place. A picture the answer is no weaker without is cut. A rival, a price or a number appears only when it is the point.
6. As long as the answer, up to fifteen minutes. No shortest length; never pad.
7. A cold listen before the founder sees it.

## The order of work
1. Propose a talk once its subject has enough behind it. Make it only on the founder's yes.
2. Read the vision. Write the question, the answer, the points, and what you left out and where it goes.
3. A reason is missing: stage the talk with two or three open questions and ask them with `surface_ask`, text starting "Talk questions:".
4. Stage the talk with its points and ask with `surface_ask`, text starting "Talk points:", offering "Yes, draw it" and "Change a point". No picture before that yes.
5. Draw. Each chapter carries one or two points, in order, in the same words. Prefer shapes drawn from numbers. Every picture names what it rests on. Plain words for the ear.
6. The cold listen. A fresh helper gets the talk-listen skill (`read_skill`), the title, the question and the spoken lines, nothing else. No helpers: save those as a note and ask with text starting "Cold listener needed:" and the note's name. Cut or rewrite what is marked. Over one line in ten marked: a fresh listener hears it again. Record the last listen in the talk. Never listen to your own talk.
7. Then stage the talk, alone in its own `stage_surface_patch` call. Captions are always on. Record a voice with `narrate_explainer` only when the founder asks.
8. When a post or bet a talk rests on changes, tell the founder which pictures no longer hold; remake them on their word.

## The seven starter talks
Add one of your own when a subject outgrows its talk.
- Why it exists: the problem, who has it, what changes for them, what the company believes. Never prices, rivals, the plan, the tests.
- Why it can work: the few claims that must all hold, and what backs each. Never the plan's steps or a product catalogue.
- How it should feel: the ideas about the experience and the reasoning behind each. Never money, suppliers, the law.
- What we found: what research found and what each finding changed. Never guesses and hopes.
- What stands in the way: the obstacles, worst first, and what each would cost. Never how each gets tested.
- What we are still guessing: each guess in plain words, what would prove it, what would end it. Never why the company exists.
- What we do next: the steps in order, what each costs, what is known afterwards. Never why the company exists or the case for the business.

Talks live in a `talks` block on a Talks tab, first on a page that has a Research tab; add it if missing. Reply in plain words, with no file or tool names.
