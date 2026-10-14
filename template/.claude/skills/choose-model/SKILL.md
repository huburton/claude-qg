---
name: choose-model
description: Chooses the model and settings for a task - a Claude model and effort for a worker or an agent, or a local LLM with temperature, top_p, thinking on/off and constrained JSON. Use before launching a worker, writing an agent or skill, or calling a local llama.cpp-compatible router from a script.
---
<!--
Sources (check again when a new model is released):
- Models, pricing, context: https://platform.claude.com/docs/en/about-claude/models/overview
- Effort and aliases in Claude Code: https://code.claude.com/docs/en/model-config
- Qwen3 model cards (no greedy decoding in thinking mode): https://huggingface.co/Qwen/Qwen3-8B
- llama.cpp server per-request parameters: https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md
- LLM-as-judge (rubric, swapped order, length bias): https://arxiv.org/abs/2602.02219v1
-->

# Choose model and settings

## 1. Claude
The real cost is the quota (5-hour and 7-day windows). Before launching several opus workers, look at `rate_limits` in
`<state dir>/statusline/<session_id>.json` (written by the hub's statusline script).

Aliases: `opus` (most reliable for long agentic work), `sonnet` (about half the price, very good on well-framed code),
`haiku` (mechanical work, sorting, summaries, far cheaper). Check current prices and context sizes on the pages above.
Some models may be billed outside the subscription (extra usage): never use them without the user's agreement.

Effort (`--effort`, frontmatter `effort:`): `low` < `medium` < `high` < `xhigh` < `max`. More effort = more thinking and
tool calls, so more quota and time. `max` only case by case.

### Grid by type of task
| Task | Model | Effort |
|---|---|---|
| The QG itself (decide, write briefs, arbitrate) | opus | the user's choice |
| Architecture, hard debugging, multi-machine, production, security | opus | high (xhigh if it already failed) |
| Well-specified code, isolated feature, script, tests | sonnet | high |
| Structured web research, comparison, sourced summary | sonnet | medium (high for a narrow subject) |
| Writing seen by other people (cover letter, page, doc) | opus | high |
| Reviewing a diff, checking a worker's proof | sonnet | medium |
| Mechanical: summarise, sort, rename, read logs, extract | haiku | low to medium |

Escalation rule: one failure -> add context; two failures -> one step up (haiku -> sonnet -> opus, or effort +1).
Never relaunch the same thing unchanged.

## 2. Local LLM: when to use it
Yes: large repetitive volume (classification, summaries), data the user prefers to keep at home, automatic loops that
must not use quota (scrapers, journal summaries, monitoring), embeddings.
No: long agentic tasks, decisions, code going to production, up-to-date facts (small models make things up).

Record here (and keep it current) your local models: name used in requests, host and port, when it is available,
context size and speed. Check availability with a status endpoint before relying on one.

## 3. Sampling settings (Qwen 3.x family; adapt to your model's card)
| Use | Thinking | temperature | top_p | top_k | min_p | presence_penalty |
|---|---|---|---|---|---|---|
| Code, precise reasoning | on | 0.6 | 0.95 | 20 | 0 | 0 |
| General, creative writing | on | 1.0 | 0.95 | 20 | 0 | 0 to 1.5 |
| Quick chat, summary, voice | off | 0.7 | 0.8 | 20 | 0 | 0 to 1.5 |
| JSON extraction, classification | off | 0.2 to 0.4 + `json_schema` | 0.8 | 20 | 0 | 0 |
| Judge / scoring | off | 0.2 to 0.3 + fixed `seed` | 0.8 | 20 | 0 | 0 |

- Never use `temperature: 0` with thinking on: the model card advises against it (endless repetition).
- A high `presence_penalty` limits repetition but can switch a non-English answer to English: lower it if that happens.
- Judge: explicit rubric with one example per grade, ask for the justification BEFORE the grade, penalise length, and in
  A/B comparisons run two passes with the order swapped. For an important decision, 3 votes and a majority.
- Server presets provide defaults: do not change them without the user, override per request instead.

Example (JSON extraction; the key stays in its file):
```
curl -s http://127.0.0.1:<port>/v1/chat/completions \
  -H "Authorization: Bearer $(cat <api key file>)" -H 'Content-Type: application/json' -d '{
  "model": "<model name>",
  "messages": [{"role":"user","content":"Extract title, city, salary from: ..."}],
  "temperature": 0.3, "top_p": 0.8, "top_k": 20, "seed": 42,
  "chat_template_kwargs": {"enable_thinking": false},
  "response_format": {"type":"json_schema","json_schema":{"name":"offer","schema":{
    "type":"object","properties":{"title":{"type":"string"},"city":{"type":"string"},
    "salary":{"type":["string","null"]}},"required":["title","city","salary"]}}}
}'
```
