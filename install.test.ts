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
    expect.objectContaining({ command: expect.stringMatching(/quiz\.ts" hook stop$/) }),
  ]);
  expect(hooks.UserPromptSubmit).toHaveLength(1);
  expect(hooks.UserPromptSubmit[0].hooks[0].command).toMatch(/hook user-prompt$/);
  expect(fs.existsSync(path.join(home, ".agents", "skills", "quiz", "SKILL.md"))).toBe(true);
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
  const dest = path.join(home, ".agents", "skills", "quiz");
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, "SKILL.md"), "mine");
  expect(() => installOpencode(home)).toThrow(/not a symlink/);
  expect(read(".agents/skills/quiz/SKILL.md")).toBe("mine");
});

it("opencode: writes a plugin shim and a /quiz command", async () => {
  installOpencode(home);
  installOpencode(home);
  const shim = read(".config/opencode/plugins/agent-teacher.ts");
  const target = JSON.parse(shim.match(/from (".*");/)![1]!);
  expect(fs.existsSync(target)).toBe(true);
  expect(read(".config/opencode/commands/quiz.md")).toMatch(/^quiz \$ARGUMENTS$/m);
});
