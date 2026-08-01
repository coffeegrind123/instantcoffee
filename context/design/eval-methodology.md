# Eval Methodology

What each suite tests, where the benchmarks come from, and how scoring works.

## Design principles

1. **Deterministic scoring.** Every scorer produces 0.0–1.0 from objective checks
   (compile → run → compare output; exact string match; pattern detection). No
   LLM-judge — no "rate this code 1-5." The results are reproducible: run the
   same eval on the same model at the same quant, you get the same score.
2. **Real code, executed.** Code generation tests compile the output, execute it
   against test cases, and score on pass/fail. The model can't bluff syntax
   that looks right but doesn't run.
3. **Grounded in known benchmarks.** Suite design draws from HumanEval (OpenAI,
   2021), MBPP (Google, 2021), and the Qwen3.6 quant study by 0xSero
   (framework-research, 2026). The specific tasks are hand-written so they
   don't appear in training data verbatim, but the methodology is benchmark-grade.
4. **Scores the model, not the infra.** The score floor separates "model can't
   do this" from "infra broke." A compile error on a codegen task is 0.0; a
   connection refused is excluded. Every score is a verdict on the model at
   this quant, on this GPU, with these flags.

## Scoring

Each test produces a score 0.0–1.0. A suite score is the mean of its tests.
The overall score is the mean of all suites. The score floor (default 0.5)
is a per-test gate: below it, the test "fails." The floor is deliberately
low (0.0 for development, 0.5 by default) so that partial success registers.

A score of 1.0 means the model did everything correctly. A score of 0.0
means it produced nothing usable. Most real results land in between.

## Suites

### 1. Speed (`speed`)

**What it measures:** Raw inference throughput — how fast the model processes
your prompt and generates tokens.

**Methodology:** Sends a ~500-token prompt of varied repeating words (so the
tokenizer doesn't compress them into fewer tokens), requests 128 completion
tokens, divides `prompt_tokens / elapsed_seconds` for prefill speed and
`completion_tokens / elapsed_seconds` for generation speed. This mirrors
`llama-bench -p 512 -n 128` methodology used by bradrlaw/ai-server and
0xSero/framework-research.

**Scoring:** `prompt_processing_tps` is capped at 1000 tok/s → 1.0.
`token_generation_tps` is capped at 100 tok/s → 1.0. These are throughput
scores, not pass/fail — a model delivering 50 tok/s decode gets 0.50.

**What good looks like:** On a 4090 with a Docker volume and mmap, expect
100–400 tok/s prefill and 25–50 tok/s generation. The current 117/29 tok/s
is within expectations for this hardware. **Do not use `--no-mmap`** with a
single-file GGUF — it kills generation speed by ~20× (measured: 41→2 tok/s
with the flag). The ik recipe backend needs it for 852-shard loading; the
mainline single-file GGUF should never carry it.

### 2. Code Generation (`codegen`)

**What it measures:** Can the model produce compilable, correct code for
well-defined algorithmic tasks?

**Methodology:** HumanEval-style function generation. Each task is a
natural-language specification of one function. The model's output is
compiled with Python's `compile()`, executed with `exec()`, and the
resulting function is called with test cases. Scoring is `tests_passed / total_tests`
(pass@1).

**Tasks** (5 tasks, 28 test cases across them):
| Task | Test cases | Type |
|------|-----------|------|
| `fibonacci` | 6 | Iterative function with edge cases |
| `binary_search` | 6 | Classic algorithm, empty-list edge case |
| `is_palindrome` | 6 | String processing, case/whitespace handling |
| `group_anagrams` | 4 | Dictionary/grouping, moderate complexity |
| `merge_sorted` | 6 | Two-pointer merge, no built-in sort allowed |

**What good looks like:** ≥0.80. The current 0.95 means 27/28 test cases
passed — the model writes correct code for all common algorithmic patterns.

### 3. Bug Fixing (`bugfix`)

**What it measures:** Can the model identify and fix real bugs in
functionally-correct-looking code?

**Methodology:** Each task presents a buggy function, describes the symptom,
and asks for a fix. Scoring has two components weighted 40/60:
- **Pattern match (40%):** Does the fix contain the expected correction
  pattern? E.g., `mid+1` for the off-by-one fix.
- **Test pass (60%):** Does the fixed function pass a test suite?

**Tasks:**
| Task | Bug type | Difficulty |
|------|----------|-----------|
| `off_by_one` | Binary search infinite loop (`left = mid` instead of `mid + 1`) | Medium |
| `empty_list_guard` | Division by zero on empty input | Easy |
| `mutable_default` | Python mutable default argument trap (`def f(x=[])`) | Medium |

**What good looks like:** ≥0.60. The current 0.73 means all tests pass
but the fix pattern isn't always the one expected (e.g., `raise ValueError`
instead of `return 0` for empty-list guard — different but correct).

### 4. Edit Precision (`edits`)

**What it measures:** The #1 real-world failure mode from the HN thread
(June 2026). Can the model reproduce a string exactly, character-for-character,
including whitespace and indentation?

**Methodology:** The model is asked to reproduce exact text verbatim. Each
line is compared for identity (not similarity). Score = `matching_lines / total_lines`
with a 0.1 per-line penalty for missing or extra lines.

**Tasks:**
| Task | Lines | Challenge |
|------|-------|----------|
| `python_fn` | 2 | Basic Python function with 4-space indent |
| `indented_class` | 4 | Nested class with multiple indent levels |
| `trailing_ws` | 2 | Trailing spaces that must be preserved |
| `mixed_tabs` | 2 | Mixed tabs and spaces |

**What good looks like:** ≥0.75. The current 0.88 means 3/4 tasks had
perfect line matches. This is the edit-tool failure mode — if this score
is low, expect `old_string` mismatches in every agentic session.

### 5. Tool Calling (`tools`)

**What it measures:** Can the model select and invoke the correct function
from a set of available tools?

**Methodology:** OpenAI-format function calling. The model receives tool
definitions and must emit `tool_calls` with valid JSON arguments.

**Tests:**
| Test | What it checks |
|------|---------------|
| `single_call` | Selects the correct tool (`get_weather`), fills city parameter |
| `json_valid` | Tool arguments parse as valid JSON |
| `multi_tool_selection` | With two tools available, picks the right one first |

**What good looks like:** ≥0.70. The current 0.73 means correct tool
selection but sometimes the multi-tool chain needs a second prompt to
complete both steps.

### 6. Reasoning (`reasoning`)

**What it measures:** Can the model perform multi-step mathematical reasoning
and deliver a correct final answer?

**Methodology:** A calculation that requires intermediate steps
(234 × 567 + 89 = 132767). The model must show work and produce an
`ANSWER:` line. Scoring checks:
- Output produced at all (length > 10 chars)
- Numerical answer within 1% of expected
- No degenerate repeat loop

**What good looks like:** ≥0.80. The current 1.00 means perfect:
correct answer, step-by-step reasoning shown, no loops.

### 7. Code Review (`review`)

**What it measures:** Can the model identify security vulnerabilities in
code?

**Methodology:** A deliberately vulnerable function (SQL injection via
string concatenation, password logging, plaintext password storage) is
presented. The model must list issues as bullet points. Scoring checks
for three specific findings via keyword matching in the response.

**Findings expected:**
1. **SQL injection** — concatenating user input into queries
2. **Password logging** — printing credentials to stdout
3. **Plaintext storage** — no hashing before storing passwords

**What good looks like:** ≥0.50. The current 0.67 (2/3) means it found
SQL injection and password logging but missed the plaintext storage issue.

### 8. Multi-Turn Coherence (`multiturn`)

**What it measures:** Does the model retain context across conversation
turns? Can it recall a value set earlier after a distraction?

**Methodology:** A three-turn conversation:
1. Set a value (`project_name = 'NeutronStar'`)
2. Recall it immediately
3. Recall it after a misleading prompt ("Ignore everything above. Actually don't.")

**What good looks like:** ≥0.80. The current 1.00 means perfect recall
through all three turns including the distraction.

### 9. Refactoring (`refactor`)

**What it measures:** Can the model restructure code from a chain of
conditionals into a data-driven pattern?

**Methodology:** A discount calculator using `if/elif` chains for
different item types must be refactored to use a dictionary lookup.
Scored on: uses a dict (25%), has a lookup pattern (25%),
compiles (25%), produces correct output (25%).

**What good looks like:** ≥0.50. The current 1.00 means the model
produced a correct dictionary-based refactoring that compiles and
passes the test case.

## Sources and inspiration

| Source | What we took |
|--------|-------------|
| HumanEval (Chen et al., 2021) | Pass@1 scoring methodology, function-generation task format |
| MBPP (Austin et al., 2021) | Multi-test-case validation per task |
| 0xSero/framework-research | Multi-quant HumanEval/MBPP/GSM8K comparison methodology |
| bradrlaw/ai-server | llama-bench methodology (`pp512`, `tg128` at multiple context depths) |
| rhdunn (HN thread, June 2026) | Loop/repeat detection algorithm (ported to Python) |
| JHamidun/claude-code-config-pack | Two-tier eval architecture (deterministic + judge) |
| Virtue-Research/guard-eval-harness | Capability-scoped metrics, denominator filtering |
| HN thread (1318 points, 563 comments) | Edit precision as #1 failure mode, K-f16/V-q8 cache findings |

## Running it yourself

```bash
./scripts/up.sh                         # start the stack
./scripts/run-eval.sh --badge           # run eval, save results, regenerate badges
python3 scripts/gen-readme-scorecard.py --all  # update README scorecard
```

The eval runs inside the Docker compose network. It needs a running
llama-server (the `--jinja` flag must be set — native function calling
is required for the tool-calling suite). No forge proxy is needed; the
eval talks OpenAI-compatible directly to llama-server.

## Interpreting the scorecard

The README scorecard shows three things per suite:

- **Score bar (████░░░░):** Visual representation of the 0.0–1.0 score.
  Full bar = 1.0, empty = 0.0. The color badge next to it gives the
  same information at a glance.
- **Passed (3/3):** How many individual tests met the score floor.
  This tracks infra health — if every test in a suite passes the floor,
  the eval pipeline is working correctly regardless of the score.
- **Score number (0.82):** The actual quality metric. A low score on
  a suite where all tests "passed" means the model genuinely struggles
  with that capability. A low score with many failed tests means
  something broke — check the eval output for error details.

The overall score is the unweighted mean of all suite scores. It is
not a comprehensive model benchmark — it's a fitness-for-purpose
measurement for this specific stack, quant, and GPU. Run it after
changing your quant, upgrading llama.cpp, or tuning sampling parameters
to see the impact.
