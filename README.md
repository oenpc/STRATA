# STRATA

**Your coding agent keeps making the same mistakes. This is a way to stop that —
by attaching rules to *classes of files* instead of individual files.**

[中文摘要](README.zh-CN.md) · [Quickstart](docs/quickstart.md) · [Why](docs/why.md)

---

## The problem

An agent working in a real repository fails in three predictable ways:

| Failure | What it looks like |
|---|---|
**It doesn't know where to look** | Reads the wrong files, misses the one that matters |
**It breaks things it didn't know about** | Changes a function, misses two callers |
**It repeats a mistake you already corrected** | You add "don't do X" to your instructions file — it does X again next week |

The usual answers — longer context windows, better retrieval, more agent autonomy —
don't address the third one. Telling an agent "don't do X" in prose is *not* the
same as making X impossible.

## The idea, in 90 seconds

Every code unit gets a **coordinate**: an architectural layer and a business domain.

```
⟨ scripts, config ⟩    ⟨ lib, rendering ⟩    ⟨ api, auth ⟩
```

That coordinate pair is a **face**. Constraints attach to faces — not to files:

```yaml
# A constraint, attached to a face
- id: no-shell-exec
  scope: scripts/*        # ← the face: everything under scripts/
  check: "! grep -rn 'execSync' src/scripts"
```

Now here is the part that matters:

> **When you add a new file under `scripts/`, the rule already covers it.**
> You write zero new rules.

Under the per-file approach, every new file means at least one new rule. Under
face anchoring, rules only grow when a **new face** appears — and faces are a
finite, small set (`|layers| × |domains|`).

This is one sentence, and it is the whole method:

**Anchor constraints to coordinate classes, not to files — so a new file inherits
its rules instead of requiring new ones.**

## Try it in 30 seconds

Measure whether the method can even help you. This is a static scan — no agent,
no logs, no LLM:

```bash
node scripts/measure.mjs --root /path/to/your/repo
```

It prints your **κ** — the share of files that live in a face shared with at
least one other file:

| κ | What it means |
|---|---|
**≥ 0.5** | The method applies well. Proceed to the quickstart. |
**0.3 – 0.5** | Partially applies. Expect benefit in your dense areas only. |
**< 0.3** | **Stop.** Your files are too heterogeneous; faces degenerate into files. Try the verification layer alone (`docs/quickstart.md` §5). |

## What you actually build

| Layer | What it is | Effort |
|---|---|---|
**S** — Sites | One line per file: `path[layer·domain·importance]: role \| related \| exports \| notes` | Medium (the bulk of the work) |
**T** — Traces | The `related` field — typed cross-file links | Low |
**R** — Registry | Your `layer × domain` dictionary | **Low — do this first** |
**A** — Anchoring | Constraints scoped to faces, not paths | Low |
**V** — Verdict | A `check` command that returns pass / fail / unknown | Medium |
**A** — Area | The combination space; coverage you get for free | — |

**Do them in that order.** Defining the dictionary *after* writing entries is the
single most common way to ruin the method: the faces degenerate into per-file
labels and you lose the whole benefit.

## Status: this is a working method, not a validated theory

I want to be direct about this, because it affects how much you should trust it:

- **The core claim — "face anchoring drives marginal rule cost to zero" — is
  derived, not yet tested.** The designed experiments (E1–E4) have not been run.
- What exists is **one origin case**, from a single developer and a single
  codebase. There, **κ = 0.68**, and a documented prohibition was **matched 21
  times over 26 days** before an executable check existed for it.
  **Those are pattern matches, not confirmed violations** — the heuristic detector
  over-counts, because a backtick pair inside a template comment is not actually a
  syntax error. **The true violation count is ≤ 21 and was not measured.**
- **n = 1.** That is an anecdote with numbers, not evidence. It shows the method
  was used once, not that it works.
- The measurements above come from observation of a real development process.
  **Observational data cannot establish causation**, and the origin case had
  specific defects: its git history was squashed, and its executable checker was
  introduced too late to support before/after comparison.

**What this means for you:** the *measurement* of κ is real and you can run it
today. The *benefit* is a hypothesis. If you adopt this, you are testing it.

Full disclosure, including what would falsify the method: [`docs/research/status.md`](docs/research/status.md)

## When not to use this

Be honest about the fit:

- **Fewer than ~30 files, or files that rarely change** — the index costs more
  than it saves.
- **κ < 0.3** — see above.
- **No way to run a check command** — without a verdict layer you get only the
  index, which is still useful but much weaker.
- **You need formal guarantees** — this is a practical convention, not a
  verification framework.

## Repository layout

```
README.md                  ← you are here (English)
README.zh-CN.md            ← Chinese summary
docs/
  quickstart.md            ← step-by-step adoption
  why.md                   ← the problem, in more depth
  reference.md             ← six elements, formal definitions, cost theorem
  adapting-logs.md         ← optional: read logs from other agent runners
  research/                ← experiments, methodology, limitations, status
templates/
  instance-index.md        ← copy into your repo and fill in
  checker.md               ← how to write the verdict layer
scripts/
  measure.mjs              ← static κ / face / coverage measurement (any repo)
  bench.mjs                ← A/B self-test: with vs without STRATA
  check-purity.mjs         ← this package's own verdict layer (see below)
  research/                ← session-log tooling (optional)
examples/
  pitfalls-example.mjs     ← how to write a pitfall detector (not a general tool)
```

## This package is its own example

STRATA says: attach constraints to *faces*, and make the verdict layer **executable**.
So this repository does that to itself.

`scripts/check-purity.mjs` is a real constraint on this package: **no project-specific
identifiers may appear outside the research/examples areas.** Rationale — if a concrete
project's rule text leaks in (say, some app's constant name), a reader can no longer tell
a *general conclusion* from *one repository's current state*.

```bash
npm run check        # exit 0 = pass, 1 = violations, 2 = cannot judge
```

Note what it does **not** do: it allows generic ecosystem names. `AGENTS.md` and
`CLAUDE.md` are common filenames, not one project's property, so banning them would
produce false positives — and **a constraint that starts crying wolf gets bypassed,
then stops working.** Only *attribution* of a rule to a specific project is flagged.

## Prior art and how this differs

| Work | What it does | Difference |
|---|---|---|
[AOCI](https://arxiv.org/abs/2605.02421) | Entry-based index + two-layer encoding for repository-scale understanding | Its tags are a flat string — **there is no face**, so constraints must be enumerated per entry |
[U-Define](https://arxiv.org/abs/2605.02765) | Splits constraints into hard/soft, verifies via model checking vs LLM judge | Planning, not repositories; measures user perception, not agent behaviour |
[Verifier-Guided Coordination](https://arxiv.org/abs/2610.04779) | Shows only an executable checker can establish a claimed property | No representation layer, no anchoring mechanism |

**Where this sits:** AOCI built a stable representation but did not solve where
constraints *attach*. The verifier line of work built executable checks but has
no representation. STRATA connects them: constraints anchor to faces, verdicts
come from executable checks.

## License

MIT — see [LICENSE](LICENSE).
