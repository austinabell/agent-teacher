#!/usr/bin/env node
// agent-quiz core: session toggle, decision deck, Leitner scheduling, and the
// hook handlers shared by the Claude Code, Codex, and opencode adapters.
// Runs directly on Node >= 22.18 (type stripping); no dependencies beyond git.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(import.meta.url);
const PROTOCOL = path.join(path.dirname(SCRIPT), "protocol.md");
const DIR = ".agent-quiz";
const DAY = 24 * 60 * 60 * 1000;
// Days until a card is due again after a correct answer, indexed by its new box (1-5).
const INTERVAL_DAYS = [0, 0, 1, 3, 7, 21] as const;
const DEFAULTS = { reviewEvery: 3, maxPerReview: 5 };

export type Result = "right" | "wrong" | "skip";
export type Confidence = "high" | "low";

export interface Card {
  id: string;
  type: "mc" | "short";
  question: string;
  options?: string[];
  answer: string;
  why: string;
  kind: string;
  commit: string | null;
  created: string;
  box: number;
  due: string;
  history: { at: string; result: Result; confidence?: Confidence }[];
}

export interface CardInput {
  question?: unknown;
  answer?: unknown;
  why?: unknown;
  type?: unknown;
  options?: unknown;
  kind?: unknown;
}

interface State {
  lastReviewSha?: string;
  lastPromptedSha?: string;
}

type Config = typeof DEFAULTS;
type Command = "on" | "off" | "status" | "review";

// ---------- project state ----------

function run(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

export function projectRoot(cwd: string): string {
  return run(cwd, ["rev-parse", "--show-toplevel"]) ?? cwd;
}

function quizDir(root: string): string {
  const dir = path.join(root, DIR);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(path.join(dir, "sessions"), { recursive: true });
    // Personal learning data; keep it out of the repo unless the user opts in.
    fs.writeFileSync(path.join(dir, ".gitignore"), "*\n");
  }
  fs.mkdirSync(path.join(dir, "sessions"), { recursive: true });
  return dir;
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, value: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

export function config(root: string): Config {
  return { ...DEFAULTS, ...readJson<Partial<Config>>(path.join(root, DIR, "config.json"), {}) };
}

const statePath = (root: string) => path.join(quizDir(root), "state.json");
const deckPath = (root: string) => path.join(quizDir(root), "deck.json");
export const readState = (root: string): State => readJson<State>(statePath(root), {});
const writeState = (root: string, s: State) => writeJson(statePath(root), s);
export const readDeck = (root: string): Card[] => readJson<Card[]>(deckPath(root), []);
const writeDeck = (root: string, d: Card[]) => writeJson(deckPath(root), d);

function sessionFile(root: string, sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9_.-]/g, "_");
  if (!safe) throw new Error("missing session id");
  return path.join(quizDir(root), "sessions", safe);
}

export function isOn(root: string, sessionId: string | undefined): boolean {
  return Boolean(sessionId) && fs.existsSync(sessionFile(root, sessionId!));
}

export function setOn(root: string, sessionId: string, on: boolean): void {
  const file = sessionFile(root, sessionId);
  if (!on) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.writeFileSync(file, new Date().toISOString() + "\n");
  const state = readState(root);
  const head = run(root, ["rev-parse", "HEAD"]);
  if (!state.lastReviewSha && head) writeState(root, { ...state, lastReviewSha: head });
}

// ---------- deck ----------

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

export function addCard(root: string, input: CardInput, now = new Date()): Card {
  if (!nonEmpty(input.question)) throw new Error('card needs a non-empty "question"');
  if (!nonEmpty(input.answer)) throw new Error('card needs a non-empty "answer"');
  const type = input.type ?? (Array.isArray(input.options) ? "mc" : "short");
  if (type !== "mc" && type !== "short") throw new Error('"type" must be "mc" or "short"');
  const options = input.options;
  if (
    type === "mc" &&
    !(Array.isArray(options) && options.length >= 2 && options.every(nonEmpty))
  ) {
    throw new Error('multiple-choice cards need at least 2 non-empty "options"');
  }
  const deck = readDeck(root);
  const card: Card = {
    id: String(deck.reduce((max, c) => Math.max(max, Number(c.id) || 0), 0) + 1),
    type,
    question: input.question.trim(),
    ...(type === "mc" ? { options: options as string[] } : {}),
    answer: input.answer.trim(),
    why: typeof input.why === "string" ? input.why.trim() : "",
    kind: nonEmpty(input.kind) ? input.kind : "decision",
    commit: run(root, ["rev-parse", "--short", "HEAD"]),
    created: now.toISOString(),
    box: 1,
    due: now.toISOString(),
    history: [],
  };
  deck.push(card);
  writeDeck(root, deck);
  return card;
}

export function grade(
  root: string,
  id: string,
  result: string,
  confidence?: string,
  now = new Date(),
): Card {
  if (result !== "right" && result !== "wrong" && result !== "skip")
    throw new Error("result must be right, wrong, or skip");
  if (confidence !== undefined && confidence !== "high" && confidence !== "low")
    throw new Error("confidence must be high or low");
  const deck = readDeck(root);
  const card = deck.find((c) => c.id === id);
  if (!card) throw new Error(`no card with id ${id}`);
  card.history.push({ at: now.toISOString(), result, ...(confidence ? { confidence } : {}) });
  if (result === "right") {
    card.box = Math.min(card.box + 1, 5);
    card.due = new Date(
      now.getTime() + INTERVAL_DAYS[card.box as 1 | 2 | 3 | 4 | 5] * DAY,
    ).toISOString();
  } else if (result === "wrong") {
    card.box = 1;
    card.due = now.toISOString();
  }
  writeDeck(root, deck);
  return card;
}

export function dueCards(deck: Card[], now = new Date(), limit = Infinity): Card[] {
  return deck
    .filter((c) => new Date(c.due) <= now)
    .sort((a, b) => a.box - b.box || Date.parse(a.due) - Date.parse(b.due))
    .slice(0, limit);
}

// Finish or snooze a review: the commit counter restarts from HEAD.
// Cards are untouched, so anything not graded stays due for the next review.
export function markReviewed(root: string): void {
  const head = run(root, ["rev-parse", "HEAD"]);
  if (!head) return;
  writeState(root, { ...readState(root), lastReviewSha: head, lastPromptedSha: head });
}

// Commits from `sha` to HEAD, or null when `sha` is unknown (e.g. rewritten history).
export function commitsSince(root: string, sha: string | undefined): number | null {
  if (!sha) return null;
  const n = run(root, ["rev-list", "--count", `${sha}..HEAD`]);
  return n === null ? null : Number(n);
}

// ---------- prompts injected into the agent ----------

const cli = (args: string) => `node "${SCRIPT}" ${args}`;

function protocolText(): string {
  return fs.readFileSync(PROTOCOL, "utf8").replaceAll("{{CLI}}", `node "${SCRIPT}"`);
}

function formatCard(c: Card): string {
  const lines = [
    `- id ${c.id} (${c.type}, box ${c.box}, from commit ${c.commit ?? "n/a"}): ${c.question}`,
  ];
  if (c.options) lines.push(`  options: ${c.options.join(" | ")}`);
  lines.push(`  answer: ${c.answer}`);
  if (c.why) lines.push(`  why: ${c.why}`);
  return lines.join("\n");
}

export function reviewPrompt(cards: Card[], reason: string): string {
  return [
    `[agent-quiz] Review due (${reason}). Quiz the user on these ${cards.length} card(s) now, before anything else.`,
    "Do not reveal an answer before the user responds. Ask for confidence (sure / unsure) with each answer.",
    'Offer "Snooze review" on the first question. After each answer, give one or two sentences of explanatory feedback.',
    `After each answer run: ${cli("grade <id> right|wrong|skip [high|low]")}`,
    `When finished, or if the user snoozes, run: ${cli("reviewed")}`,
    "",
    ...cards.map(formatCard),
  ].join("\n");
}

const reminder = () =>
  `[agent-quiz] Quiz mode is ON. Before any non-trivial design decision, ask the user to predict or choose first (offer "Skip, just decide"). Offer small pieces of educational or fun code for the user to write by hand: prepare a stub with a TODO and wait for them. Log every notable decision as a card with ${cli("add")}. If the full protocol is no longer in your context, read ${PROTOCOL}.`;

// ---------- hook handlers (tool-agnostic) ----------

const COMMANDS: readonly string[] = ["on", "off", "status", "review"];

function normalize(arg: string | undefined): Command | null {
  const a = (arg ?? "").toLowerCase();
  if (a === "") return "status";
  return COMMANDS.includes(a) ? (a as Command) : null;
}

// Matches "quiz on", "/quiz off", "$quiz status", "/agent-quiz:quiz review", "/quiz",
// and Claude Code's expanded <command-name>/<command-args> form.
export function parseCommand(prompt: unknown): Command | null {
  const text = String(prompt ?? "").trim();
  if (/<command-name>\/?(?:agent-quiz:)?quiz<\/command-name>/i.test(text)) {
    return normalize(text.match(/<command-args>\s*(\w*)\s*<\/command-args>/i)?.[1]);
  }
  const plain = text.match(/^[/$]?(?:agent-quiz:)?quiz(?:\s+(\w+))?\s*$/i);
  return plain ? normalize(plain[1]) : null;
}

function statusText(root: string, sessionId: string | undefined): string {
  const deck = readDeck(root);
  const since = commitsSince(root, readState(root).lastReviewSha);
  return `[agent-quiz] Quiz mode is ${isOn(root, sessionId) ? "ON" : "OFF"} for this session. Deck: ${deck.length} card(s), ${dueCards(deck).length} due. Commits since last review: ${since ?? "unknown"} (review every ${config(root).reviewEvery}). Tell the user this in one line.`;
}

export interface PromptEvent {
  sessionId: string | undefined;
  prompt: unknown;
  cwd: string;
}

// Returns text to add to the agent's context, or null.
export function handleUserPrompt({ sessionId, prompt, cwd }: PromptEvent): string | null {
  const root = projectRoot(cwd);
  const cmd = parseCommand(prompt);
  if ((cmd === "on" || cmd === "off") && !sessionId)
    return "[agent-quiz] No session id was provided by the tool, so quiz mode cannot be toggled. Tell the user.";
  switch (cmd) {
    case "on":
      setOn(root, sessionId!, true);
      return `[agent-quiz] Quiz mode is now ON for this session. Confirm to the user in one line, then follow this protocol for the rest of the session:\n\n${protocolText()}`;
    case "off":
      setOn(root, sessionId!, false);
      return "[agent-quiz] Quiz mode is now OFF for this session. Stop following the agent-quiz protocol. Confirm to the user in one line.";
    case "status":
      return statusText(root, sessionId);
    case "review": {
      const due = dueCards(readDeck(root), new Date(), config(root).maxPerReview);
      return due.length === 0
        ? "[agent-quiz] No cards are due. Tell the user in one line."
        : reviewPrompt(due, "requested by the user");
    }
    default:
      return isOn(root, sessionId) ? reminder() : null;
  }
}

export interface StopEvent {
  sessionId: string | undefined;
  cwd: string;
  stopHookActive: boolean;
}

// Returns a continuation prompt when a review is due, or null to let the agent stop.
export function handleStop({ sessionId, cwd, stopHookActive }: StopEvent): string | null {
  const root = projectRoot(cwd);
  if (stopHookActive || !isOn(root, sessionId)) return null;
  const head = run(root, ["rev-parse", "HEAD"]);
  if (!head) return null;
  const state = readState(root);
  // Prompt at most once per HEAD, so an ignored review can't loop.
  if (state.lastPromptedSha === head) return null;
  const since = commitsSince(root, state.lastReviewSha);
  if (since === null) {
    // No baseline, or history was rewritten: restart the counter here.
    writeState(root, { ...state, lastReviewSha: head });
    return null;
  }
  const { reviewEvery, maxPerReview } = config(root);
  if (since < reviewEvery) return null;
  const due = dueCards(readDeck(root), new Date(), maxPerReview);
  if (due.length === 0) {
    writeState(root, { ...state, lastReviewSha: head, lastPromptedSha: head });
    return null;
  }
  writeState(root, { ...state, lastPromptedSha: head });
  return reviewPrompt(due, `${since} commits since the last review`);
}

// ---------- CLI ----------

function readStdin(): string {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

interface HookInput {
  session_id?: string;
  cwd?: string;
  prompt?: string;
  stop_hook_active?: boolean;
}

// Claude Code and Codex share this hook I/O shape.
function runHook(event: string | undefined): void {
  const input = JSON.parse(readStdin() || "{}") as HookInput;
  const cwd = input.cwd || process.cwd();
  if (event === "user-prompt") {
    const context = handleUserPrompt({ sessionId: input.session_id, prompt: input.prompt, cwd });
    if (context)
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context },
        }),
      );
  } else if (event === "stop") {
    const reason = handleStop({
      sessionId: input.session_id,
      cwd,
      stopHookActive: input.stop_hook_active === true,
    });
    if (reason) process.stdout.write(JSON.stringify({ decision: "block", reason }));
  } else {
    throw new Error(`unknown hook event: ${event}`);
  }
}

const USAGE = `usage:
  quiz.ts add                        card JSON on stdin: {"question","answer","why","type":"mc"|"short","options":[...],"kind"}
  quiz.ts grade <id> right|wrong|skip [high|low]
  quiz.ts reviewed                   finish or snooze a review (restarts the commit counter)
  quiz.ts due                        list due cards
  quiz.ts hook user-prompt|stop      called by tool hooks, JSON on stdin`;

export function main(argv: string[], cwd = process.cwd()): void {
  const [cmd, ...args] = argv;
  const root = projectRoot(cwd);
  switch (cmd) {
    case "add": {
      const card = addCard(root, JSON.parse(readStdin()) as CardInput);
      console.log(`added card ${card.id}`);
      break;
    }
    case "grade": {
      const [id, result, confidence] = args;
      if (!id || !result) throw new Error("usage: grade <id> right|wrong|skip [high|low]");
      const card = grade(root, id, result, confidence);
      console.log(`card ${card.id}: box ${card.box}, due ${card.due}`);
      break;
    }
    case "reviewed":
      markReviewed(root);
      console.log("review recorded; commit counter restarted");
      break;
    case "due":
      console.log(dueCards(readDeck(root)).map(formatCard).join("\n") || "nothing due");
      break;
    case "hook":
      runHook(args[0]);
      break;
    default:
      console.error(USAGE);
      process.exitCode = 2;
  }
}

// argv[1] may not exist on disk (opencode's Bun binary reports /$bunfs/root/opencode).
const invokedDirectly = (() => {
  try {
    return fs.realpathSync(process.argv[1] ?? "") === fs.realpathSync(SCRIPT);
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(`agent-quiz: ${(err as Error).message}`);
    // A hook failure must never block the agent; other commands report failure.
    process.exitCode = process.argv[2] === "hook" ? 0 : 1;
  }
}
