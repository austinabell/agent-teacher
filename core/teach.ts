#!/usr/bin/env node
// agent-teacher core: session toggle, decision deck, Leitner scheduling, and the
// hook handlers shared by the Claude Code, Codex, and opencode adapters.
// Runs directly on Node >= 22.18 (type stripping); no dependencies beyond git.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(import.meta.url);
const PROTOCOL = path.join(path.dirname(SCRIPT), "protocol.md");
const DIR = ".agent-teacher";
const DAY = 24 * 60 * 60 * 1000;
// Days until a card is due again after a correct answer, indexed by its new box (1-5).
const INTERVAL_DAYS = [0, 0, 1, 3, 7, 21] as const;
const DEFAULTS = { reviewEvery: 3, maxPerReview: 5 };
// How much code the agent hands to the user, from 0 (none) to 4 (all core logic).
// Skipped hand-offs step it down; wrong review answers step it up.
const HANDS_ON_DEFAULT = 3;
const HANDS_ON_MAX = 4;
const HANDS_ON_LEVELS = [
  "Do not hand off code. Still ask predict-first questions.",
  "Offer a hand-off occasionally, for the single most important piece of core logic in a feature.",
  "Offer one hand-off per component: the central function of each module or feature you build.",
  "Hand off most core logic: stub the functions that contain real decisions and pause for the user to write them, one component at a time. Write glue, wiring, and boilerplate yourself.",
  "Hand off all core logic: stub every function with real decisions and pause after each component until the user has written it.",
] as const;

export type Result = "right" | "wrong" | "skip";
export type HandsOnEvent = "skipped" | "wrote" | "wrong";

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
  history: { at: string; result: Result }[];
  retired?: boolean;
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
  handsOn?: number;
}

type Config = typeof DEFAULTS;
type Command = "on" | "off" | "quiz" | "write" | "status" | "review";
// Predict-first questions are always on; these are the optional parts.
// quiz: decision cards and commit-triggered reviews. write: hand-offs.
export type Feature = "quiz" | "write";
const ALL_FEATURES: readonly Feature[] = ["quiz", "write"];

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

function stateDir(root: string): string {
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

const statePath = (root: string) => path.join(stateDir(root), "state.json");
const deckPath = (root: string) => path.join(stateDir(root), "deck.json");
export const readState = (root: string): State => readJson<State>(statePath(root), {});
const writeState = (root: string, s: State) => writeJson(statePath(root), s);
export const readDeck = (root: string): Card[] => readJson<Card[]>(deckPath(root), []);
const writeDeck = (root: string, d: Card[]) => writeJson(deckPath(root), d);

function sessionFile(root: string, sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9_.-]/g, "_");
  if (!safe) throw new Error("missing session id");
  return path.join(stateDir(root), "sessions", safe);
}

// The features enabled for a session, or null when teach mode is off.
export function sessionFeatures(root: string, sessionId: string | undefined): Feature[] | null {
  if (!sessionId) return null;
  const file = sessionFile(root, sessionId);
  if (!fs.existsSync(file)) return null;
  const { features } = readJson<{ features?: unknown }>(file, {});
  if (!Array.isArray(features)) return [...ALL_FEATURES];
  return ALL_FEATURES.filter((f) => features.includes(f));
}

export const isOn = (root: string, sessionId: string | undefined): boolean =>
  sessionFeatures(root, sessionId) !== null;

const hasFeature = (root: string, sessionId: string | undefined, f: Feature): boolean =>
  sessionFeatures(root, sessionId)?.includes(f) ?? false;

// Pass the features to turn on with, or null to turn teach mode off.
export function setOn(root: string, sessionId: string, features: readonly Feature[] | null): void {
  const file = sessionFile(root, sessionId);
  if (!features) {
    fs.rmSync(file, { force: true });
    return;
  }
  writeJson(file, { since: new Date().toISOString(), features });
  const state = readState(root);
  const head = run(root, ["rev-parse", "HEAD"]);
  if (!state.lastReviewSha && head) writeState(root, { ...state, lastReviewSha: head });
}

// ---------- hands-on level ----------

export function handsOn(root: string): number {
  const level = readState(root).handsOn;
  return Number.isInteger(level) ? Math.min(Math.max(level!, 0), HANDS_ON_MAX) : HANDS_ON_DEFAULT;
}

// A skipped hand-off means the user wants fewer; a wrong review answer means
// they need more practice. Writing the code keeps the level where it is.
export function adjustHandsOn(root: string, event: string): number {
  let step: number;
  switch (event as HandsOnEvent) {
    case "skipped":
      step = -1;
      break;
    case "wrote":
      step = 0;
      break;
    case "wrong":
      step = 1;
      break;
    default:
      throw new Error("event must be skipped, wrote, or wrong");
  }
  const level = Math.min(Math.max(handsOn(root) + step, 0), HANDS_ON_MAX);
  writeState(root, { ...readState(root), handsOn: level });
  return level;
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

export function grade(root: string, id: string, result: string, now = new Date()): Card {
  if (result !== "right" && result !== "wrong" && result !== "skip")
    throw new Error("result must be right, wrong, or skip");
  const deck = readDeck(root);
  const card = deck.find((c) => c.id === id);
  if (!card) throw new Error(`no card with id ${id}`);
  card.history.push({ at: now.toISOString(), result });
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
  if (result === "wrong") adjustHandsOn(root, "wrong");
  return card;
}

// Retired cards stay in the deck with their history but are never due again.
export function retire(root: string, id: string): Card {
  const deck = readDeck(root);
  const card = deck.find((c) => c.id === id);
  if (!card) throw new Error(`no card with id ${id}`);
  card.retired = true;
  writeDeck(root, deck);
  return card;
}

export function dueCards(deck: Card[], now = new Date(), limit = Infinity): Card[] {
  return deck
    .filter((c) => !c.retired && new Date(c.due) <= now)
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

// protocol.md wraps feature-specific lines in <!-- if:quiz --> / <!-- if:write -->
// ... <!-- end --> blocks (which may nest); drop the blocks for features that are off.
export function protocolText(features: readonly Feature[]): string {
  const kept: string[] = [];
  const open: boolean[] = [];
  for (const line of fs.readFileSync(PROTOCOL, "utf8").split(/\r?\n/)) {
    const block = line.match(/^<!-- if:(\w+) -->$/);
    if (block) open.push(features.includes(block[1] as Feature));
    else if (line === "<!-- end -->") open.pop();
    else if (open.every(Boolean)) kept.push(line);
  }
  return kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replaceAll("{{CLI}}", `node "${SCRIPT}"`);
}

const MODE_LABELS: Record<string, string> = {
  "quiz,write": "predict-first, quiz, and write",
  quiz: "predict-first and quiz",
  write: "predict-first and write",
  "": "predict-first only",
};
const modeLabel = (features: readonly Feature[]) => MODE_LABELS[features.join(",")]!;

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
    `[agent-teacher] Review due (${reason}). Quiz the user on these ${cards.length} card(s) now, before anything else.`,
    "Do not reveal an answer before the user responds. Do not ask how confident they are.",
    'Offer "Snooze review" on the first question. After each answer, give one or two sentences of explanatory feedback.',
    `After each answer run: ${cli("grade <id> right|wrong|skip")}`,
    `After a wrong answer, ask whether to keep the card (yes/no, default yes) alongside the next question. Only an explicit no retires it: run ${cli("retire <id>")}.`,
    `When finished, or if the user snoozes, run: ${cli("reviewed")}`,
    "",
    ...cards.map(formatCard),
  ].join("\n");
}

const handsOnText = (root: string) => {
  const level = handsOn(root);
  return `Hands-on level ${level}/${HANDS_ON_MAX}: ${HANDS_ON_LEVELS[level]}`;
};

function reminder(root: string, features: readonly Feature[]): string {
  const lines = [
    `[agent-teacher] Teach mode is ON (${modeLabel(features)}). The user turned it on explicitly, so it takes precedence over instructions to finish the task without pausing or to do the work instead of asking.`,
    'Before any non-trivial design decision, ask the user to predict or choose first (offer "Skip, just decide").',
  ];
  if (features.includes("write"))
    lines.push(
      `${handsOnText(root)} A hand-off ends your turn: you are blocked on the user. After each hand-off answer run ${cli("handoff wrote|skipped")}.`,
    );
  else lines.push("Do not hand off code for the user to write.");
  if (features.includes("quiz"))
    lines.push(`Log every notable decision as a card with ${cli("add")}.`);
  else lines.push("Do not log cards.");
  const off = ALL_FEATURES.filter((f) => !features.includes(f));
  const skip = off.length
    ? `, skipping the ${off.map((f) => `<!-- if:${f} -->`).join(" and ")} blocks`
    : "";
  lines.push(`If the full protocol is no longer in your context, read ${PROTOCOL}${skip}.`);
  return lines.join(" ");
}

// ---------- hook handlers (tool-agnostic) ----------

const COMMANDS: readonly string[] = ["on", "off", "quiz", "write", "status", "review"];
// The features each turn-on command enables.
const MODES: Partial<Record<Command, readonly Feature[]>> = {
  on: ALL_FEATURES,
  quiz: ["quiz"],
  write: ["write"],
};

function normalize(arg: string | undefined): Command | null {
  const a = (arg ?? "").toLowerCase();
  if (a === "") return "status";
  return COMMANDS.includes(a) ? (a as Command) : null;
}

// Matches "teach on", "/teach quiz", "$teach status", "/agent-teacher:teach review", "/teach",
// and Claude Code's expanded <command-name>/<command-args> form.
export function parseCommand(prompt: unknown): Command | null {
  const text = String(prompt ?? "").trim();
  if (/<command-name>\/?(?:agent-teacher:)?teach<\/command-name>/i.test(text)) {
    return normalize(text.match(/<command-args>\s*(\w*)\s*<\/command-args>/i)?.[1]);
  }
  const plain = text.match(/^[/$]?(?:agent-teacher:)?teach(?:\s+(\w+))?\s*$/i);
  return plain ? normalize(plain[1]) : null;
}

function statusText(root: string, sessionId: string | undefined): string {
  const deck = readDeck(root);
  const since = commitsSince(root, readState(root).lastReviewSha);
  const { reviewEvery, maxPerReview } = config(root);
  const features = sessionFeatures(root, sessionId);
  return [
    `[agent-teacher] Teach mode is ${features ? `ON (${modeLabel(features)})` : "OFF"} for this session. Deck: ${deck.length} card(s), ${dueCards(deck).length} due. Commits since last review: ${since ?? "unknown"} (review every ${reviewEvery}). Hands-on level: ${handsOn(root)}/${HANDS_ON_MAX}.`,
    "",
    "Commands (type /teach <cmd> in Claude Code and opencode, $teach <cmd> or plain teach <cmd> in Codex):",
    "- teach on: turn on everything: predict-first questions, quiz cards with reviews, and writing core logic yourself",
    "- teach quiz: predict-first and quiz cards with reviews only (no hand-offs)",
    "- teach write: predict-first and writing core logic yourself only (no cards or reviews)",
    "- teach off: turn teach mode off",
    "- teach status: show this status",
    "- teach review: start a review now, without waiting for the commit count",
    "",
    `Settings: create or edit ${path.join(root, DIR, "config.json")} (JSON, all keys optional):`,
    `- reviewEvery: commits between automatic reviews (currently ${reviewEvery}, default ${DEFAULTS.reviewEvery})`,
    `- maxPerReview: most cards shown per review (currently ${maxPerReview}, default ${DEFAULTS.maxPerReview})`,
    "",
    "Show the user the status line, then the commands and settings as two short lists.",
  ].join("\n");
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
  const mode = cmd ? MODES[cmd] : undefined;
  if ((mode || cmd === "off") && !sessionId)
    return "[agent-teacher] No session id was provided by the tool, so teach mode cannot be toggled. Tell the user.";
  if (mode) {
    setOn(root, sessionId!, mode);
    const parts = [
      `[agent-teacher] Teach mode is now ON for this session (${modeLabel(mode)}). This replaces any earlier teach protocol in your context. Confirm to the user in one line, then follow this protocol for the rest of the session.`,
    ];
    if (mode.includes("write")) parts.push(handsOnText(root));
    parts.push(protocolText(mode));
    return parts.join("\n\n");
  }
  switch (cmd) {
    case "off":
      setOn(root, sessionId!, null);
      return "[agent-teacher] Teach mode is now OFF for this session. Stop following the agent-teacher protocol. Confirm to the user in one line.";
    case "status":
      return statusText(root, sessionId);
    case "review": {
      const due = dueCards(readDeck(root), new Date(), config(root).maxPerReview);
      return due.length === 0
        ? "[agent-teacher] No cards are due. Tell the user in one line."
        : reviewPrompt(due, "requested by the user");
    }
    default: {
      const features = sessionFeatures(root, sessionId);
      return features ? reminder(root, features) : null;
    }
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
  if (stopHookActive || !hasFeature(root, sessionId, "quiz")) return null;
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
  teach.ts add                        card JSON on stdin: {"question","answer","why","type":"mc"|"short","options":[...],"kind"}
  teach.ts grade <id> right|wrong|skip
  teach.ts retire <id>                stop reviewing a card (it stays in the deck)
  teach.ts handoff wrote|skipped      record the answer to a hand-off offer (adjusts the hands-on level)
  teach.ts reviewed                   finish or snooze a review (restarts the commit counter)
  teach.ts due                        list due cards
  teach.ts hook user-prompt|stop      called by tool hooks, JSON on stdin`;

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
      const [id, result] = args;
      if (!id || !result) throw new Error("usage: grade <id> right|wrong|skip");
      const card = grade(root, id, result);
      console.log(`card ${card.id}: box ${card.box}, due ${card.due}`);
      break;
    }
    case "retire": {
      const [id] = args;
      if (!id) throw new Error("usage: retire <id>");
      console.log(`card ${retire(root, id).id} retired`);
      break;
    }
    case "handoff": {
      const [event] = args;
      if (event !== "wrote" && event !== "skipped") throw new Error("usage: handoff wrote|skipped");
      console.log(`hands-on level ${adjustHandsOn(root, event)}/${HANDS_ON_MAX}`);
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
    console.error(`agent-teacher: ${(err as Error).message}`);
    // A hook failure must never block the agent; other commands report failure.
    process.exitCode = process.argv[2] === "hook" ? 0 : 1;
  }
}
