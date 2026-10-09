# agent-quiz

A quiz mode for coding agents, so you actually know the decisions your agent made.
It is off by default and you turn it on per session. While it is on:

1. **Predict first.** Before a non-trivial design decision, the agent asks you to pick an option, then reveals its choice and the reason.
2. **Decision cards.** The agent logs every notable decision as a quiz card, including the ones it did not ask you about.
3. **Write it yourself.** The agent stubs core logic (functions with real decisions in them: algorithms, parsing, business rules, failure paths) with a `TODO` and pauses for you to write it, one component at a time. It writes the glue and boilerplate itself, then reviews your code and runs the tests. How much it hands off depends on a hands-on level from 0 to 4, starting at 3. The idea comes from Anthropic's [learning-output-style](https://github.com/anthropics/claude-code/tree/main/plugins/learning-output-style) plugin.
4. **Review every few commits.** After 3 commits (yours or the agent's), the agent quizzes you on the cards that are due. Cards come back on a spaced-repetition schedule.

You can skip any part at any time. A predict-first question always offers "Skip, just decide", and a hand-off always offers "Skip, you write it". Each skipped hand-off lowers the hands-on level by one, and each wrong review answer raises it by one. The level is stored per project in `.agent-quiz/state.json`, and `quiz status` shows it. A review can be snoozed, and snoozed cards stay due for the next one. After a wrong answer, the agent asks whether to keep the card; answering no retires it, so it stays in `.agent-quiz/deck.json` but never comes up again.

Works with Claude Code, Codex, and opencode. All three share one core (`core/quiz.ts`).

## Why

The problem: when an agent writes the code, it is easy to skim its output and miss design decisions. Rereading the output more carefully doesn't fix this, because rereading is one of the least effective ways to learn. Being asked questions works much better.

### Research findings

- **Practice testing and spaced practice are the two most effective study techniques.** Dunlosky et al. (2013) reviewed ten techniques and rated only these two "high utility". Rereading and highlighting were rated "low". ([APS summary](https://www.psychologicalscience.org/publications/journals/pspi/learning-techniques.html), [AFT article](https://www.aft.org/ae/fall2013/dunlosky))
- **Testing beats restudying.** The testing effect holds across meta-analyses ([Rowland 2014](https://www.researchgate.net/publication/264988491_The_Effect_of_Testing_Versus_Restudy_on_Retention_A_Meta-Analytic_Review_of_the_Testing_Effect)). In Adesope et al. (2017), multiple-choice practice tests had a larger effect (g = 0.70) than short-answer tests (g = 0.48) ([summary](https://theeconomyofmeaning.com/2017/03/21/important-new-meta-analysis-on-the-testing-effect-with-some-surprises/)).
- **Feedback matters, especially for multiple choice.** In classroom studies, short-answer questions helped retention even without feedback, but multiple-choice questions did not ([Greving & Richter 2018](https://www.frontiersin.org/journals/psychology/articles/10.3389/fpsyg.2018.02412/full), [2022](https://www.tandfonline.com/doi/full/10.1080/20445911.2022.2085281)). So agent-quiz mixes both formats and always explains the answer.
- **Corrected mistakes tend to come back.** Errors fixed by feedback tend to return after about a week ([Butler, Fazio & Marsh 2011](https://link.springer.com/article/10.3758/s13423-011-0173-y)). So a missed card goes back to the start of the schedule, unless you choose to retire it.
- **Guessing before you see the answer helps, even when the guess is wrong.** The benefit only applies to the items you were asked about ([pretesting review](https://pmc.ncbi.nlm.nih.gov/articles/PMC12292081/)). This is why the agent asks you to predict a decision, not just to read it.
- **Producing something yourself beats reading it.** Information you generate is remembered better than information you read (the generation effect; [Bertsch et al. 2007 meta-analysis](https://doi.org/10.3758/BF03193441)). This is why the agent hands small pieces of code to you.
- **AI help can cost you understanding.** In an Anthropic study of 52 developers learning a new library, the group using AI scored 50% on a comprehension quiz, against 67% for the group coding by hand. The largest gap was in debugging. Developers who asked the AI conceptual questions kept more ([Anthropic research](https://www.anthropic.com/research/AI-assistance-coding-skills), [DevClass coverage](https://www.devclass.com/ai-ml/2026/02/02/anthropic-research-skilled-devs-make-better-use-of-ai-but-using-ai-is-bad-for-learning-skills/4079561)).

### Goals

- You can explain every important decision in the code your agent wrote: what was chosen, and why.
- Getting there costs as little attention as possible: short questions at natural break points, and nothing while quiz mode is off.
- It never blocks you. Every question can be skipped, and skipping never loses a card.
- Your own commits count toward the review threshold. The commit count comes from git, not from watching the agent's commands.

## Install

Requirements: Node 22.18 or newer (it runs the `.ts` files directly) and git. There are no runtime dependencies.

### Claude Code

```
/plugin marketplace add /path/to/claude-quiz
/plugin install agent-quiz@agent-quiz
```

Restart the session afterwards.

### Codex

```
node install.ts codex
```

This merges two hooks into `~/.codex/hooks.json` and keeps any hooks you already have there. It also links the skill to `~/.agents/skills/quiz`. Then:

1. Add `hooks = true` under `[features]` in `~/.codex/config.toml`. The installer tells you if this is missing.
2. Start Codex and run `/hooks` to review and trust the two agent-quiz hooks.

Hooks go in the global `hooks.json` because Codex currently doesn't run hooks bundled inside plugins.

### opencode

```
node install.ts opencode
```

This writes a plugin to `~/.config/opencode/plugins/agent-quiz.ts`, adds a `/quiz` command, and links the skill. Restart opencode afterwards. See the opencode limitation under [Limitations](#limitations) before relying on it.

## Usage

| Command       | Effect                                                                                  |
| ------------- | --------------------------------------------------------------------------------------- |
| `quiz on`     | Turn quiz mode on for this session                                                      |
| `quiz off`    | Turn it off                                                                             |
| `quiz status` | Show whether it is on, the card count, how many are due, the commands, and the settings |
| `quiz review` | Start a review now, without waiting for the commit count                                |

Type the command as `/quiz on` in Claude Code and opencode. In Codex, type `$quiz on` or plain `quiz on`. The hook handles the command before the model sees it, so toggling costs no tool call.

## How it works

- **Hooks.** On every prompt, a `UserPromptSubmit` hook (`chat.message` in opencode) applies any toggle command. While quiz mode is on, it adds a short reminder of the protocol in `core/protocol.md`. When the agent finishes a turn, a `Stop` hook (`session.idle` in opencode) checks the commit count. Once 3 commits have been made since the last review and at least one card is due, it starts a review.
- **Cards.** Each card is multiple choice or short answer, and records the commit where the decision was made. The agent adds cards with `node core/quiz.ts add`.
- **Schedule.** A Leitner box system. A right answer moves the card up one box. Box 1 is due right away, then the intervals are 1, 3, 7 and 21 days. A wrong answer sends the card back to box 1, and a skipped card stays where it is. A review shows at most 5 cards, starting with the lowest box.
- **No loops.** A review is offered at most once per HEAD commit, and never while a stop hook is already active.

### State

Everything is stored in `.agent-quiz/` at the repository root. That directory gitignores itself.

| File          | Contents                                          |
| ------------- | ------------------------------------------------- |
| `deck.json`   | Cards, their boxes, due dates, and history        |
| `state.json`  | The commit at the last review                     |
| `sessions/`   | One file per session where quiz mode is on        |
| `config.json` | Optional: `{"reviewEvery": 3, "maxPerReview": 5}` |

## Limitations

- **Predict-first depends on the agent's judgment.** The agent decides which decisions are non-trivial, which code is worth handing off, and which cards to log. The hooks only remind it of the rules.
- **opencode 2.x is not supported yet.** The adapter uses the opencode 1.x plugin API and has unit tests for it. opencode 2.0.15 loads the plugin without errors but never calls its hooks. 2.x has a new plugin API with no published types yet (the npm `latest` of `@opencode-ai/plugin` is 1.18.35). Not tested against a live opencode 1.x install.
- **Codex has not been run end to end.** Its hooks use the same JSON input and output as Claude Code, and that format is unit tested. Claude Code has been verified end to end.
- **The evidence is about learning in general, not this tool.** The Anthropic study measured comprehension right after the task. Whether spaced quizzing on agent decisions improves long-term understanding has not been measured.

## Development

```
pnpm install
pnpm test        # vitest
pnpm typecheck   # tsc --noEmit
pnpm lint        # oxlint
pnpm format      # oxfmt
```
