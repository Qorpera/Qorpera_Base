---
name: research-posts
description: How to answer one question with a research post: a plan the founder approves first, every source saved, the short answer first, and a second reader's check before the founder sees it. Use whenever a question needs evidence.
---

# Research posts

A research post answers one question from sources anyone can open again. The founder decides on it, so it is worth nothing unless every number in it can be trusted. Work in this order and skip no step.

## 1. One question
- One post answers one question, written as the founder would ask it. A second question is a second post.
- Read the company's vision first, whole, and the posts this interface already has. A question they answer gets a link, not a new post.

## 2. The plan, then the founder's yes
Before you open one source, show the plan with your ask tool (`surface_ask`), its text starting "Research plan:":
- what you will find out: the question and the few facts that would answer it;
- where you will look, by kind of source: makers' own pages, the regulator, studies, price lists;
- what only the founder knows and you need: money they will put in, what may give way, who they have already spoken to. Ask it as open questions, never as your guess for them to confirm.

Offer "Yes, research it" and "Change the plan". Their yes is a hard blocker by rule: nothing is read before it. What they answer is a fact with the founder as its source.

## 3. Reading
- Save every source the moment you read it, in the post's `sources`: its title, who published it, its link, the day you opened it, and the line it backs in the source's own figures and currency.
- Say what kind each is: a maker's own page, a reseller, a regulator, a study, a vendor's claim. A fact you could not open yourself (a search summary, a page behind a wall) is unconfirmed and carries no claim.
- If your run can start helpers, split the sources among them by kind and let them read side by side, each returning sources in that shape. A run on GPT has no helpers: read alone, one source after another, and plan for fewer.
- Look for what would prove the answer wrong. What you looked for and did not find goes in `notFound`, with what would close it.

## 4. Writing
- One writer, from the saved sources only. A figure with no saved source is cut or becomes a `notFound` line. Nothing comes from memory.
- The short answer first: at most five claims, one sentence each, each ending in the mark of the source behind it.
- Then as long as the evidence needs and no longer: plain sentences, a chart or table where figures are compared, a mark after every sentence a source backs.
- Say what this changes: which page, which line on it, what that line says now.
- Say how the answer was found: when, how many sources, which kinds count as firm, what was left out.
- Give the post its theme, a cover picture of its main finding, and the posts it relates to.

## 5. The check, before the founder sees anything
A second reader who has seen none of your reasoning opens every source again and checks each number and name against it. Its whole brief is the research-check skill (`read_skill`).
- If your run can start a helper, give a fresh one the draft and that skill, nothing else.
- If it cannot, save the draft as a note and ask with text starting "Second reader needed:" and the note's name. It reaches the Co-Founder, who has one do the check. Say that nothing is needed from the founder.
- Never check your own post, and never set a source's checked day yourself. A post is refused when staged while one source is unchecked.
- What fails is cut, or moved to `notFound`. Then stage the post alone in its own `stage_surface_patch` call.

## What the founder is told
The plan, then the post. Reply in plain words: the answer in one sentence, how many sources stand behind it, what could not be found. No file names, no tool names, no steps.
