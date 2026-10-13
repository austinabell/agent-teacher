import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, expect, it } from "vitest";
import { installCodex, installOpencode } from "./install.ts";

let home: string;
const read = (p: string) => fs.readFileSync(path.join(home, p), "utf8");

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-teacher-home-"));
});

it("codex: adds both hooks, keeps the user's hooks, and is idempotent", () => {
  fs.mkdirSync(path.join(home, ".codex"));
  const mine = { type: "command", command: "my-stop.sh" };
  fs.writeFileSync(
    path.join(home, ".codex", "hooks.json"),
    JSON.stringify({ hooks: { Stop: [{ hooks: [mine] }] } }),
  );
  installCodex(home);
  installCodex(home);
  const hooks = JSON.parse(read(".codex/hooks.json")).hooks;
  expect(hooks.Stop.flatMap((g: { hooks: unknown[] }) => g.hooks)).toEqual([
    mine,
    expect.objectContaining({ command: expect.stringMatching(/teach\.ts" hook stop$/) }),
  ]);
  expect(hooks.UserPromptSubmit).toHaveLength(1);
  expect(hooks.UserPromptSubmit[0].hooks[0].command).toMatch(/hook user-prompt$/);
  expect(fs.existsSync(path.join(home, ".agents", "skills", "teach", "SKILL.md"))).toBe(true);
});

it("codex: asks for the feature flag only when it is missing", () => {
  expect(installCodex(home).join("\n")).toMatch(/hooks = true/);
  fs.writeFileSync(path.join(home, ".codex", "config.toml"), "[features]\nhooks = true\n");
  expect(installCodex(home).join("\n")).not.toMatch(/hooks = true/);
});

it("codex: fails loudly on a malformed hooks.json instead of overwriting it", () => {
  fs.mkdirSync(path.join(home, ".codex"));
  fs.writeFileSync(path.join(home, ".codex", "hooks.json"), "{broken");
  expect(() => installCodex(home)).toThrow();
  expect(read(".codex/hooks.json")).toBe("{broken");
});

it("refuses to replace a real skill directory", () => {
  const dest = path.join(home, ".agents", "skills", "teach");
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, "SKILL.md"), "mine");
  expect(() => installOpencode(home)).toThrow(/not a symlink/);
  expect(read(".agents/skills/teach/SKILL.md")).toBe("mine");
});

it("opencode: writes a plugin shim and a /teach command", async () => {
  installOpencode(home);
  installOpencode(home);
  const shim = read(".config/opencode/plugins/agent-teacher.ts");
  const target = JSON.parse(shim.match(/from (".*");/)![1]!);
  expect(fs.existsSync(target)).toBe(true);
  expect(read(".config/opencode/commands/teach.md")).toMatch(/^teach \$ARGUMENTS$/m);
});

it("codex: replaces hooks that still point at the old core/quiz.ts", () => {
  fs.mkdirSync(path.join(home, ".codex"));
  const old = { type: "command", command: 'node "/old/core/quiz.ts" hook stop' };
  fs.writeFileSync(
    path.join(home, ".codex", "hooks.json"),
    JSON.stringify({ hooks: { Stop: [{ hooks: [old] }] } }),
  );
  installCodex(home);
  const commands = JSON.parse(read(".codex/hooks.json")).hooks.Stop.flatMap(
    (g: { hooks: { command: string }[] }) => g.hooks.map((h) => h.command),
  );
  expect(commands).toEqual([expect.stringMatching(/teach\.ts" hook stop$/)]);
});

it("opencode: removes the old /quiz command it wrote, but not someone else's", () => {
  const commands = path.join(home, ".config", "opencode", "commands");
  fs.mkdirSync(commands, { recursive: true });
  const old = "---\ndescription: Toggle agent-quiz mode\n---\n";
  fs.writeFileSync(path.join(commands, "quiz.md"), old);
  installOpencode(home);
  expect(fs.existsSync(path.join(commands, "quiz.md"))).toBe(false);
  fs.writeFileSync(path.join(commands, "quiz.md"), "my own quiz command");
  installOpencode(home);
  expect(read(".config/opencode/commands/quiz.md")).toBe("my own quiz command");
});
