import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PluginInput } from "@opencode-ai/plugin";
import { beforeEach, expect, it } from "vitest";
import { addCard } from "../../core/quiz.ts";
import { AgentQuiz } from "./plugin.ts";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};
let repo: string;
let prompts: unknown[];

function git(...args: string[]): void {
  execFileSync("git", args, { cwd: repo, env: GIT_ENV });
}

async function load() {
  const client = { session: { prompt: async (req: unknown) => void prompts.push(req) } };
  return AgentQuiz({ client, directory: repo } as unknown as PluginInput);
}

const textPart = (text: string, synthetic = false) => ({
  id: "p",
  sessionID: "s1",
  messageID: "m",
  type: "text" as const,
  text,
  synthetic,
});

async function send(hooks: Awaited<ReturnType<typeof load>>, text: string): Promise<string[]> {
  await hooks["chat.message"]!(
    { sessionID: "s1" },
    { message: {} as never, parts: [textPart(text)] },
  );
  const output = { system: [] as string[] };
  await hooks["experimental.chat.system.transform"]!(
    { sessionID: "s1", model: {} as never },
    output,
  );
  return output.system;
}

const idle = (hooks: Awaited<ReturnType<typeof load>>) =>
  hooks.event!({ event: { type: "session.idle", properties: { sessionID: "s1" } } });

beforeEach(() => {
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agent-quiz-oc-")));
  prompts = [];
  git("init", "-q");
  git("commit", "--allow-empty", "-q", "-m", "init");
});

it("injects nothing while quiz mode is off", async () => {
  const hooks = await load();
  expect(await send(hooks, "fix the bug")).toEqual([]);
});

it("toggles on, injects the protocol once, then a reminder per message", async () => {
  const hooks = await load();
  const [on] = await send(hooks, "quiz on");
  expect(on).toMatch(/now ON/);
  const empty = { system: [] as string[] };
  await hooks["experimental.chat.system.transform"]!(
    { sessionID: "s1", model: {} as never },
    empty,
  );
  expect(empty.system).toEqual([]);
  expect((await send(hooks, "fix the bug"))[0]).toMatch(/Quiz mode is ON/);
});

it("ignores synthetic parts when reading the prompt", async () => {
  const hooks = await load();
  await hooks["chat.message"]!(
    { sessionID: "s1" },
    { message: {} as never, parts: [textPart("quiz on", true), textPart("hello")] },
  );
  const output = { system: [] as string[] };
  await hooks["experimental.chat.system.transform"]!(
    { sessionID: "s1", model: {} as never },
    output,
  );
  expect(output.system).toEqual([]);
});

it("sends a review prompt on session.idle once the commit threshold is reached", async () => {
  const hooks = await load();
  await send(hooks, "quiz on");
  addCard(repo, { question: "Why a queue?", answer: "backpressure" });
  await idle(hooks);
  expect(prompts).toEqual([]);
  for (let i = 0; i < 3; i++) git("commit", "--allow-empty", "-q", "-m", `c${i}`);
  await idle(hooks);
  expect(prompts).toHaveLength(1);
  expect(JSON.stringify(prompts[0])).toMatch(/Why a queue\?/);
  await idle(hooks);
  expect(prompts).toHaveLength(1);
});
