import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import {
  addCard,
  adjustHandsOn,
  type Card,
  config,
  dueCards,
  grade,
  handleStop,
  handleUserPrompt,
  handsOn,
  isOn,
  markReviewed,
  nextCard,
  parseCommand,
  protocolText,
  readDeck,
  readState,
  retire,
  sessionFeatures,
  workerBrief,
} from "./teach.ts";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "teach.ts");
const DAY = 24 * 60 * 60 * 1000;
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

let repo: string;

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, env: GIT_ENV, encoding: "utf8" }).trim();
}

function commit(n = 1): void {
  for (let i = 0; i < n; i++) git("commit", "--allow-empty", "-q", "-m", `c${Math.random()}`);
}

function tmpDir(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agent-teacher-")));
}

const card = (over: Partial<Card> = {}): Card => ({
  id: "1",
  type: "short",
  question: "q",
  answer: "a",
  why: "",
  kind: "decision",
  commit: null,
  created: new Date(0).toISOString(),
  box: 1,
  due: new Date(0).toISOString(),
  history: [],
  ...over,
});

beforeEach(() => {
  repo = tmpDir();
  git("init", "-q");
  commit();
});

describe("parseCommand", () => {
  it.each([
    ["teach on", "on"],
    ["/teach off", "off"],
    ["$teach status", "status"],
    ["/agent-teacher:teach review", "review"],
    ["  TEACH ON  ", "on"],
    ["teach quiz", "quiz"],
    ["/teach write", "write"],
    ["/teach", "status"],
    ["teach", "status"],
    [
      "<command-name>/agent-teacher:teach</command-name>\n<command-message>teach</command-message>\n<command-args>on</command-args>",
      "on",
    ],
    ["<command-name>/teach</command-name>", "status"],
  ])("%j -> %s", (prompt, expected) => {
    expect(parseCommand(prompt)).toBe(expected);
  });

  it.each([
    "teach me about the parser",
    "teach onx",
    "teach bogus",
    "please teach on",
    "",
    undefined,
    "/teaching on",
  ])("%j -> null", (prompt) => {
    expect(parseCommand(prompt)).toBeNull();
  });
});

describe("addCard", () => {
  it("assigns increasing ids and records the commit", () => {
    const a = addCard(repo, { question: "q1", answer: "a1" });
    const b = addCard(repo, {
      question: "q2",
      answer: "a2",
      why: " because ",
      options: ["x", "y"],
    });
    expect([a.id, b.id]).toEqual(["1", "2"]);
    expect(a.type).toBe("short");
    expect(b.type).toBe("mc");
    expect(b.why).toBe("because");
    expect(a.commit).toBe(git("rev-parse", "--short", "HEAD"));
    expect(readDeck(repo)).toHaveLength(2);
  });

  it("makes new cards due immediately in box 1", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const c = addCard(repo, { question: "q", answer: "a" }, now);
    expect(c.box).toBe(1);
    expect(c.due).toBe(now.toISOString());
  });

  it.each([
    [{ answer: "a" }, /question/],
    [{ question: "  ", answer: "a" }, /question/],
    [{ question: "q" }, /answer/],
    [{ question: "q", answer: "a", type: "essay" }, /type/],
    [{ question: "q", answer: "a", type: "mc" }, /options/],
    [{ question: "q", answer: "a", options: ["only"] }, /options/],
    [{ question: "q", answer: "a", options: ["x", ""] }, /options/],
  ])("rejects %j", (input, message) => {
    expect(() => addCard(repo, input)).toThrow(message);
    expect(readDeck(repo)).toEqual([]);
  });

  it("creates a self-ignoring state directory", () => {
    addCard(repo, { question: "q", answer: "a" });
    expect(fs.readFileSync(path.join(repo, ".agent-teacher", ".gitignore"), "utf8")).toBe("*\n");
    expect(git("status", "--porcelain")).toBe("");
  });
});

describe("grade", () => {
  const now = new Date("2026-01-01T00:00:00Z");

  it("moves a right answer up one box with a growing interval", () => {
    addCard(repo, { question: "q", answer: "a" }, now);
    const expectedDays = [1, 3, 7, 21, 21];
    for (const days of expectedDays) {
      const c = grade(repo, "1", "right", now);
      expect(Date.parse(c.due) - now.getTime()).toBe(days * DAY);
    }
    expect(readDeck(repo)[0]!.box).toBe(5);
  });

  it("sends a wrong answer back to box 1, due now", () => {
    addCard(repo, { question: "q", answer: "a" }, now);
    grade(repo, "1", "right", now);
    grade(repo, "1", "right", now);
    const c = grade(repo, "1", "wrong", now);
    expect(c.box).toBe(1);
    expect(c.due).toBe(now.toISOString());
    expect(c.history.map((h) => h.result)).toEqual(["right", "right", "wrong"]);
  });

  it("leaves box and due unchanged on skip but records it", () => {
    const before = addCard(repo, { question: "q", answer: "a" }, now);
    const c = grade(repo, "1", "skip", new Date(now.getTime() + DAY));
    expect([c.box, c.due]).toEqual([before.box, before.due]);
    expect(c.history).toHaveLength(1);
  });

  it.each([
    ["1", "maybe", /result/],
    ["99", "right", /no card/],
  ])("rejects grade(%s, %s)", (id, result, message) => {
    addCard(repo, { question: "q", answer: "a" });
    expect(() => grade(repo, id, result)).toThrow(message);
  });
});

describe("retire", () => {
  it("keeps the card and its history but stops it coming due", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    addCard(repo, { question: "q", answer: "a" }, now);
    grade(repo, "1", "wrong", now);
    expect(dueCards(readDeck(repo), now)).toHaveLength(1);
    retire(repo, "1");
    const [c] = readDeck(repo);
    expect(c!.retired).toBe(true);
    expect(c!.history.map((h) => h.result)).toEqual(["wrong"]);
    expect(dueCards(readDeck(repo), now)).toEqual([]);
  });

  it("rejects an unknown id", () => {
    expect(() => retire(repo, "99")).toThrow(/no card/);
  });
});

describe("hands-on level", () => {
  const now = new Date("2026-01-01T00:00:00Z");

  it("defaults to 3", () => {
    expect(handsOn(repo)).toBe(3);
  });

  it("steps down on skips and stops at 0", () => {
    expect([1, 2, 3, 4].map(() => adjustHandsOn(repo, "skipped"))).toEqual([2, 1, 0, 0]);
    expect(readState(repo).handsOn).toBe(0);
  });

  it("steps up on wrong answers and stops at 4", () => {
    expect([1, 2].map(() => adjustHandsOn(repo, "wrong"))).toEqual([4, 4]);
  });

  it("stays put when the user writes the code", () => {
    adjustHandsOn(repo, "skipped");
    expect(adjustHandsOn(repo, "wrote")).toBe(2);
  });

  it("rejects unknown events without changing the level", () => {
    expect(() => adjustHandsOn(repo, "maybe")).toThrow(/skipped, wrote, or wrong/);
    expect(() => adjustHandsOn(repo, "toString")).toThrow(/skipped, wrote, or wrong/);
    expect(handsOn(repo)).toBe(3);
  });

  it.each([
    [9, 4],
    [-2, 0],
    [1.5, 3],
    ["2", 3],
    [null, 3],
  ])("reads a hand-edited level %j as %i", (stored, expected) => {
    fs.mkdirSync(path.join(repo, ".agent-teacher"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, ".agent-teacher", "state.json"),
      JSON.stringify({ handsOn: stored }),
    );
    expect(handsOn(repo)).toBe(expected);
  });

  it("keeps the review baseline when it changes", () => {
    commit();
    markReviewed(repo);
    const before = readState(repo).lastReviewSha;
    adjustHandsOn(repo, "skipped");
    expect(readState(repo).lastReviewSha).toBe(before);
  });

  it("rises when a review answer is graded wrong, not right or skip", () => {
    addCard(repo, { question: "q", answer: "a" }, now);
    grade(repo, "1", "right", now);
    grade(repo, "1", "skip", now);
    expect(handsOn(repo)).toBe(3);
    grade(repo, "1", "wrong", now);
    expect(handsOn(repo)).toBe(4);
  });

  it("shows up in status and in the teach-on message", () => {
    adjustHandsOn(repo, "skipped");
    const on = handleUserPrompt({ sessionId: "s1", prompt: "teach on", cwd: repo });
    expect(on).toMatch(/Hands-on level 2\/4: Offer one hand-off per component/);
    expect(on).toMatch(/## Precedence/);
    const status = handleUserPrompt({ sessionId: "s1", prompt: "teach status", cwd: repo });
    expect(status).toMatch(/Hands-on level: 2\/4/);
  });
});

describe("dueCards", () => {
  it("returns only due cards, lowest box then oldest first, up to the limit", () => {
    const now = new Date("2026-06-01T00:00:00Z");
    const deck = [
      card({ id: "future", due: "2026-07-01T00:00:00Z" }),
      card({ id: "box2", box: 2, due: "2026-01-01T00:00:00Z" }),
      card({ id: "box1-new", due: "2026-05-01T00:00:00Z" }),
      card({ id: "box1-old", due: "2026-02-01T00:00:00Z" }),
      card({ id: "exact", box: 3, due: now.toISOString() }),
      card({ id: "retired", due: "2026-01-01T00:00:00Z", retired: true }),
    ];
    expect(dueCards(deck, now).map((c) => c.id)).toEqual(["box1-old", "box1-new", "box2", "exact"]);
    expect(dueCards(deck, now, 2).map((c) => c.id)).toEqual(["box1-old", "box1-new"]);
    expect(dueCards([], now)).toEqual([]);
  });
});

describe("nextCard", () => {
  const now = new Date("2026-06-01T12:00:00Z");
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
  const HOUR = 60 * 60 * 1000;
  const graded = (at: string) => [{ at, result: "wrong" as const }];

  it("returns nothing for an empty deck", () => {
    expect(nextCard([], now)).toBeUndefined();
  });

  it("skips retired and not-yet-due cards", () => {
    const deck = [
      card({ id: "retired", retired: true }),
      card({ id: "future", due: "2026-07-01T00:00:00Z" }),
    ];
    expect(nextCard(deck, now)).toBeUndefined();
  });

  it("serves the newest unseen card first, ahead of a lower-box older card", () => {
    const deck = [
      card({ id: "seen", history: graded(ago(2 * HOUR)) }),
      card({ id: "old", box: 2, created: ago(5 * HOUR) }),
      card({ id: "new", box: 2, created: ago(HOUR) }),
    ];
    expect(nextCard(deck, now)?.id).toBe("new");
  });

  it("falls back to the due order once every due card has been seen", () => {
    const deck = [
      card({ id: "box2", box: 2, history: graded(ago(2 * HOUR)) }),
      card({ id: "box1", history: graded(ago(2 * HOUR)) }),
    ];
    expect(nextCard(deck, now)?.id).toBe("box1");
  });

  it("holds back a card graded under an hour ago, and only that long", () => {
    expect(nextCard([card({ history: graded(ago(HOUR - 1)) })], now)).toBeUndefined();
    expect(nextCard([card({ history: graded(ago(HOUR)) })], now)?.id).toBe("1");
  });

  it("does not re-ask a card graded wrong or skipped just now", () => {
    addCard(repo, { question: "q", answer: "a" }, now);
    expect(nextCard(readDeck(repo), now)?.id).toBe("1");
    grade(repo, "1", "wrong", now);
    expect(nextCard(readDeck(repo), now)).toBeUndefined();
    addCard(repo, { question: "q2", answer: "a" }, now);
    grade(repo, "2", "skip", now);
    expect(nextCard(readDeck(repo), now)).toBeUndefined();
  });
});

describe("deck lock", () => {
  const lock = () => path.join(repo, ".agent-teacher", "deck.json.lock");

  it("keeps every card when processes add at the same time", async () => {
    const count = 20;
    await Promise.all(
      Array.from(
        { length: count },
        (_, i) =>
          new Promise<void>((resolve, reject) => {
            const child = spawn("node", [SCRIPT, "add"], { cwd: repo, stdio: "pipe" });
            child.on("error", reject);
            child.on("close", (code) =>
              code === 0 ? resolve() : reject(new Error(`add exited ${code}`)),
            );
            child.stdin.end(JSON.stringify({ question: `q${i}`, answer: "a" }));
          }),
      ),
    );
    const deck = readDeck(repo);
    expect(deck).toHaveLength(count);
    expect(new Set(deck.map((c) => c.id)).size).toBe(count);
  }, 20_000);

  it("removes a stale lock and carries on", () => {
    addCard(repo, { question: "q", answer: "a" });
    fs.writeFileSync(lock(), "");
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock(), old, old);
    expect(addCard(repo, { question: "q2", answer: "a" }).id).toBe("2");
    expect(fs.existsSync(lock())).toBe(false);
  });

  it("gives up with an error on a lock that is still held", () => {
    addCard(repo, { question: "q", answer: "a" });
    fs.writeFileSync(lock(), "");
    expect(() => addCard(repo, { question: "q2", answer: "a" })).toThrow(/deck lock/);
    expect(() => grade(repo, "1", "right")).toThrow(/deck lock/);
    expect(() => retire(repo, "1")).toThrow(/deck lock/);
    fs.rmSync(lock());
    expect(readDeck(repo)).toHaveLength(1);
    expect(readDeck(repo)[0]!.history).toEqual([]);
  }, 20_000);

  it("releases the lock when the change fails", () => {
    expect(() => grade(repo, "99", "right")).toThrow(/no card/);
    expect(fs.existsSync(lock())).toBe(false);
    expect(() => retire(repo, "99")).toThrow(/no card/);
    expect(fs.existsSync(lock())).toBe(false);
  });
});

describe("workerBrief", () => {
  it("fills in the CLI and strips every feature block", () => {
    for (const features of [["quiz"], ["write"], ["quiz", "write"]] as const) {
      const text = workerBrief(repo, features);
      expect(text).not.toMatch(/<!--|\{\{CLI\}\}|\n\n\n/);
      expect(text).toMatch(/DECISION NEEDED/);
    }
  });

  it("includes card logging only with quiz, and hand-offs only with write", () => {
    const quiz = workerBrief(repo, ["quiz"]);
    expect(quiz).toContain(`node "${SCRIPT}" add`);
    expect(quiz).not.toMatch(/HAND-OFF|Hands-on level/);
    const write = workerBrief(repo, ["write"]);
    expect(write).toMatch(/HAND-OFF/);
    expect(write).toMatch(/Hands-on level 3\/4/);
    expect(write).not.toContain(`node "${SCRIPT}" add`);
  });

  it("uses the project's current hands-on level", () => {
    adjustHandsOn(repo, "skipped");
    expect(workerBrief(repo, ["quiz", "write"])).toMatch(/Hands-on level 2\/4/);
  });
});

describe("quizzing during the work", () => {
  const prompt = (p: string) => handleUserPrompt({ sessionId: "s1", prompt: p, cwd: repo });

  it("is described in the protocol with quiz on, and not with write alone", () => {
    expect(protocolText(["quiz"])).toMatch(/## Quiz during the work/);
    expect(protocolText(["quiz"])).toContain(`node "${SCRIPT}" next`);
    expect(protocolText(["quiz"])).not.toMatch(/Hand-offs from a worker|HAND-OFF/);
    expect(protocolText(["quiz", "write"])).toMatch(/HAND-OFF/);
    expect(protocolText(["write"])).not.toMatch(/Quiz during the work|DECISION NEEDED/);
    expect(protocolText([])).not.toMatch(/Quiz during the work/);
  });

  it.each([
    ["teach quiz", "worker-brief quiz"],
    ["teach on", "worker-brief quiz,write"],
  ])("%s reminds with the exact brief command", (toggle, expected) => {
    prompt(toggle);
    const reminder = prompt("fix the bug")!;
    expect(reminder).toContain(`node "${SCRIPT}" ${expected}`);
    expect(reminder).toContain(`node "${SCRIPT}" next`);
  });

  it("is not in the reminder for write mode", () => {
    prompt("teach write");
    expect(prompt("fix the bug")).not.toMatch(/worker-brief|background/);
  });
});

describe("handleUserPrompt", () => {
  const prompt = (p: string, sessionId: string | null = "s1") =>
    handleUserPrompt({ sessionId: sessionId ?? undefined, prompt: p, cwd: repo });

  it("is silent when teach mode is off and the prompt is not a command", () => {
    expect(prompt("fix the bug")).toBeNull();
  });

  it("turns teach mode on with the protocol, then reminds on every prompt", () => {
    const on = prompt("teach on");
    expect(on).toMatch(/now ON/);
    expect(on).toMatch(/Predict first/);
    expect(on).toMatch(/Hand off core logic for the user to write/);
    expect(on).not.toMatch(/\{\{CLI\}\}/);
    expect(isOn(repo, "s1")).toBe(true);
    expect(readState(repo).lastReviewSha).toBe(git("rev-parse", "HEAD"));
    const reminder = prompt("fix the bug");
    expect(reminder).toMatch(/Teach mode is ON/);
    expect(reminder).toMatch(/Hands-on level 3\/4: Hand off most core logic/);
    expect(reminder).toMatch(/takes precedence/);
    expect(reminder).toMatch(/handoff wrote\|skipped/);
  });

  it("keeps sessions independent", () => {
    prompt("teach on", "s1");
    expect(prompt("fix the bug", "s2")).toBeNull();
  });

  it("turns teach mode off", () => {
    prompt("teach on");
    expect(prompt("/teach off")).toMatch(/now OFF/);
    expect(isOn(repo, "s1")).toBe(false);
    expect(prompt("fix the bug")).toBeNull();
  });

  it("does not move an existing review baseline when turned on again", () => {
    prompt("teach on");
    const first = readState(repo).lastReviewSha;
    commit();
    prompt("teach on", "s2");
    expect(readState(repo).lastReviewSha).toBe(first);
  });

  it("reports status", () => {
    addCard(repo, { question: "q", answer: "a" });
    expect(prompt("teach status")).toMatch(/OFF.*1 card\(s\), 1 due/);
  });

  it("includes usage commands and settings in status", () => {
    fs.mkdirSync(path.join(repo, ".agent-teacher"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, ".agent-teacher", "config.json"),
      JSON.stringify({ reviewEvery: 2 }),
    );
    const status = prompt("teach status")!;
    for (const cmd of ["on", "quiz", "write", "off", "status", "review"])
      expect(status).toContain(`teach ${cmd}`);
    expect(status).toContain(path.join(repo, ".agent-teacher", "config.json"));
    expect(status).toMatch(/reviewEvery.*currently 2/);
    expect(status).toMatch(/maxPerReview.*currently 5/);
  });

  it("starts a review on request, or says nothing is due", () => {
    expect(prompt("teach review")).toMatch(/No cards are due/);
    addCard(repo, { question: "Why a queue?", answer: "backpressure" });
    const review = prompt("teach review");
    expect(review).toMatch(/Review due/);
    expect(review).toMatch(/Why a queue\?/);
    expect(review).toMatch(/Do not ask how confident/);
    expect(review).toMatch(/keep the card \(yes\/no, default yes\)/);
    expect(review).toMatch(/retire <id>/);
  });

  it("refuses to toggle without a session id", () => {
    expect(prompt("teach on", null)).toMatch(/No session id/);
    expect(prompt("fix the bug", null)).toBeNull();
  });

  it("sanitizes session ids into a single file name", () => {
    prompt("teach on", "../../evil");
    expect(fs.readdirSync(path.join(repo, ".agent-teacher", "sessions"))).toEqual([".._.._evil"]);
  });
});

describe("modes", () => {
  const prompt = (p: string, sessionId = "s1") =>
    handleUserPrompt({ sessionId, prompt: p, cwd: repo });

  it("turns on only the requested features", () => {
    prompt("teach quiz");
    expect(sessionFeatures(repo, "s1")).toEqual(["quiz"]);
    prompt("teach write");
    expect(sessionFeatures(repo, "s1")).toEqual(["write"]);
    prompt("teach on");
    expect(sessionFeatures(repo, "s1")).toEqual(["quiz", "write"]);
    prompt("teach off");
    expect(sessionFeatures(repo, "s1")).toBeNull();
  });

  it("quiz mode keeps predict-first and cards but drops hand-offs", () => {
    const on = prompt("teach quiz")!;
    expect(on).toMatch(/now ON for this session \(predict-first and quiz\)/);
    expect(on).toMatch(/## Predict first/);
    expect(on).toMatch(/## Log every notable decision as a card/);
    expect(on).toMatch(/## Reviews/);
    expect(on).not.toMatch(/Hand off core logic|Hands-on level|Let me write it|handoff/);
    const reminder = prompt("fix the bug")!;
    expect(reminder).toMatch(/Teach mode is ON \(predict-first and quiz\)/);
    expect(reminder).toMatch(/Do not hand off code/);
    expect(reminder).toMatch(/ add/);
    expect(reminder).not.toMatch(/Hands-on level/);
    expect(reminder).toMatch(/skipping the <!-- if:write --> blocks/);
  });

  it("write mode keeps predict-first and hand-offs but drops cards and reviews", () => {
    const on = prompt("teach write")!;
    expect(on).toMatch(/\(predict-first and write\)/);
    expect(on).toMatch(/## Predict first/);
    expect(on).toMatch(/## Hand off core logic for the user to write/);
    expect(on).toMatch(/Let me write it/);
    expect(on).toMatch(/Hands-on level 3\/4/);
    expect(on).not.toMatch(/## Log every notable decision|## Reviews|Log a card/);
    const reminder = prompt("fix the bug")!;
    expect(reminder).toMatch(/Do not log cards/);
    expect(reminder).toMatch(/handoff wrote\|skipped/);
  });

  it("strips every feature block and marker from the protocol", () => {
    for (const features of [[], ["quiz"], ["write"], ["quiz", "write"]] as const) {
      const text = protocolText(features);
      expect(text).not.toMatch(/<!--|\{\{CLI\}\}|\n\n\n/);
      expect(text).toMatch(/## Precedence/);
    }
    expect(protocolText(["quiz"])).toMatch(/## Reviews/);
    expect(protocolText(["write"])).not.toMatch(/Log a card/);
    expect(protocolText(["quiz", "write"])).toMatch(/Log a card/);
  });

  it("does not start reviews in write mode", () => {
    prompt("teach write");
    addCard(repo, { question: "q", answer: "a" });
    commit(3);
    expect(handleStop({ sessionId: "s1", cwd: repo, stopHookActive: false })).toBeNull();
  });

  it("still allows a review on request in write mode", () => {
    prompt("teach write");
    addCard(repo, { question: "q", answer: "a" });
    expect(prompt("teach review")).toMatch(/Review due/);
  });

  it("shows the mode in status", () => {
    prompt("teach quiz");
    expect(prompt("teach status")).toMatch(/Teach mode is ON \(predict-first and quiz\)/);
  });

  it("treats a session file without features as everything on", () => {
    fs.mkdirSync(path.join(repo, ".agent-teacher", "sessions"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".agent-teacher", "sessions", "s1"), "2026-01-01T00:00:00Z\n");
    expect(sessionFeatures(repo, "s1")).toEqual(["quiz", "write"]);
  });
});

describe("handleStop", () => {
  const stop = (stopHookActive = false) =>
    handleStop({ sessionId: "s1", cwd: repo, stopHookActive });
  const turnOn = () => handleUserPrompt({ sessionId: "s1", prompt: "teach on", cwd: repo });

  it("does nothing when teach mode is off", () => {
    addCard(repo, { question: "q", answer: "a" });
    commit(5);
    expect(stop()).toBeNull();
  });

  it("waits until the commit threshold is reached", () => {
    turnOn();
    addCard(repo, { question: "q", answer: "a" });
    commit(2);
    expect(stop()).toBeNull();
    commit();
    expect(stop()).toMatch(/3 commits since the last review/);
  });

  it("prompts once per HEAD and respects stop_hook_active", () => {
    turnOn();
    addCard(repo, { question: "q", answer: "a" });
    commit(3);
    expect(stop(true)).toBeNull();
    expect(stop()).not.toBeNull();
    expect(stop()).toBeNull();
    commit();
    expect(stop()).not.toBeNull();
  });

  it("restarts the counter silently when nothing is due", () => {
    turnOn();
    commit(3);
    expect(stop()).toBeNull();
    expect(readState(repo).lastReviewSha).toBe(git("rev-parse", "HEAD"));
  });

  it("restarts the counter after a review or snooze, keeping cards due", () => {
    turnOn();
    addCard(repo, { question: "q", answer: "a" });
    commit(3);
    expect(stop()).not.toBeNull();
    markReviewed(repo);
    commit(2);
    expect(stop()).toBeNull();
    commit();
    expect(stop()).toMatch(/id 1/);
  });

  it("resets the baseline when history was rewritten", () => {
    turnOn();
    addCard(repo, { question: "q", answer: "a" });
    fs.writeFileSync(
      path.join(repo, ".agent-teacher", "state.json"),
      JSON.stringify({ lastReviewSha: "deadbeef".repeat(5) }),
    );
    commit(3);
    expect(stop()).toBeNull();
    expect(readState(repo).lastReviewSha).toBe(git("rev-parse", "HEAD"));
  });

  it("honors reviewEvery and maxPerReview from config.json", () => {
    turnOn();
    fs.writeFileSync(
      path.join(repo, ".agent-teacher", "config.json"),
      JSON.stringify({ reviewEvery: 1, maxPerReview: 1 }),
    );
    expect(config(repo)).toEqual({ reviewEvery: 1, maxPerReview: 1 });
    addCard(repo, { question: "first", answer: "a" });
    addCard(repo, { question: "second", answer: "a" });
    commit();
    const reason = stop();
    expect(reason).toMatch(/1 card\(s\)/);
    expect(reason).not.toMatch(/second/);
  });

  it("does nothing outside a git repository", () => {
    const dir = tmpDir();
    handleUserPrompt({ sessionId: "s1", prompt: "teach on", cwd: dir });
    addCard(dir, { question: "q", answer: "a" });
    expect(handleStop({ sessionId: "s1", cwd: dir, stopHookActive: false })).toBeNull();
  });

  it("does nothing in a repository with no commits", () => {
    repo = tmpDir();
    git("init", "-q");
    turnOn();
    expect(stop()).toBeNull();
  });
});

describe("CLI", () => {
  const cli = (args: string[], input = "", cwd = repo) =>
    spawnSync("node", [SCRIPT, ...args], { cwd, input, encoding: "utf8" });

  it("imports cleanly when argv[1] is not a real file (opencode's Bun binary)", () => {
    const code = `process.argv[1] = "/$bunfs/root/opencode"; await import(${JSON.stringify(SCRIPT)});`;
    const r = spawnSync("node", ["--input-type=module", "-e", code], { encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  it("emits Claude Code / Codex UserPromptSubmit JSON", () => {
    const r = cli(
      ["hook", "user-prompt"],
      JSON.stringify({ session_id: "s1", prompt: "teach on", cwd: repo }),
    );
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(out.hookSpecificOutput.additionalContext).toMatch(/now ON/);
  });

  it("emits a Stop block decision when a review is due", () => {
    cli(
      ["hook", "user-prompt"],
      JSON.stringify({ session_id: "s1", prompt: "teach on", cwd: repo }),
    );
    addCard(repo, { question: "q", answer: "a" });
    commit(3);
    const r = cli(
      ["hook", "stop"],
      JSON.stringify({ session_id: "s1", cwd: repo, stop_hook_active: false }),
    );
    const out = JSON.parse(r.stdout);
    expect(out.decision).toBe("block");
    expect(out.reason).toMatch(/Review due/);
  });

  it("prints nothing when there is nothing to say", () => {
    const r = cli(["hook", "stop"], JSON.stringify({ session_id: "s1", cwd: repo }));
    expect([r.status, r.stdout]).toEqual([0, ""]);
  });

  it("never fails a hook, even on malformed input", () => {
    const r = cli(["hook", "user-prompt"], "{not json");
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/agent-teacher:/);
  });

  it("adds, grades, and lists cards", () => {
    expect(
      cli(["add"], JSON.stringify({ question: "Why WAL?", answer: "crash safety" })).stdout,
    ).toMatch(/added card 1/);
    expect(cli(["due"]).stdout).toMatch(/Why WAL\?/);
    expect(cli(["grade", "1", "wrong"]).stdout).toMatch(/box 1/);
    expect(cli(["retire", "1"]).stdout).toMatch(/card 1 retired/);
    expect(cli(["due"]).stdout).toMatch(/nothing due/);
    expect(cli(["reviewed"]).status).toBe(0);
  });

  it("serves one card at a time from next", () => {
    expect(cli(["next"]).stdout).toMatch(/nothing to ask/);
    cli(["add"], JSON.stringify({ question: "older", answer: "a" }));
    cli(["add"], JSON.stringify({ question: "newer", answer: "a" }));
    const first = cli(["next"]);
    expect(first.status).toBe(0);
    expect(first.stdout).toMatch(/newer/);
    expect(first.stdout.match(/^- id /gm)).toHaveLength(1);
    expect(first.stdout).toMatch(/answer: a/);
    cli(["grade", "1", "skip"]);
    cli(["grade", "2", "skip"]);
    expect(cli(["next"]).stdout).toMatch(/nothing to ask/);
  });

  it("prints the worker brief for the given features", () => {
    const r = cli(["worker-brief", "quiz,write"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/DECISION NEEDED/);
    expect(r.stdout).toMatch(/HAND-OFF/);
    expect(cli(["worker-brief", "quiz"]).stdout).not.toMatch(/HAND-OFF/);
  });

  it.each([[[]], [[""]], [["bogus"]], [["quiz,bogus"]], [["quiz,"]]])(
    "rejects worker-brief with arguments %j",
    (args) => {
      const r = cli(["worker-brief", ...args]);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/usage: worker-brief/);
      expect(r.stdout).toBe("");
    },
  );

  it("records hand-off answers", () => {
    expect(cli(["handoff", "skipped"]).stdout).toMatch(/hands-on level 2\/4/);
    expect(cli(["handoff", "wrote"]).stdout).toMatch(/hands-on level 2\/4/);
    const bad = cli(["handoff", "wrong"]);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/usage: handoff wrote\|skipped/);
    expect(cli(["handoff"]).status).toBe(1);
  });

  it("exits non-zero on bad input to non-hook commands", () => {
    expect(cli(["add"], "{oops").status).toBe(1);
    expect(cli(["add"], JSON.stringify({ question: "q" })).stderr).toMatch(/answer/);
    expect(cli(["grade", "1"]).status).toBe(1);
    expect(cli(["retire"]).stderr).toMatch(/usage: retire <id>/);
    expect(cli(["retire", "99"]).status).toBe(1);
    expect(cli(["nope"]).status).toBe(2);
  });
});
