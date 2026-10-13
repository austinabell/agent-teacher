#!/usr/bin/env node
// Installs agent-teacher into Codex and/or opencode. Claude Code installs through
// its plugin marketplace instead (see README). Safe to re-run.
// usage: node install.ts codex|opencode [...]

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CORE = path.join(ROOT, "core", "quiz.ts");

interface HookHandler {
  type: string;
  command: string;
  timeout?: number;
}
interface HooksFile {
  hooks?: Record<string, { matcher?: string; hooks: HookHandler[] }[]>;
  [key: string]: unknown;
}

const isOurs = (h: HookHandler) => /core[\\/]quiz\.ts" hook /.test(h.command);

function linkSkill(home: string): string {
  const dest = path.join(home, ".agents", "skills", "quiz");
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const existing = fs.lstatSync(dest, { throwIfNoEntry: false });
  if (existing?.isSymbolicLink()) fs.unlinkSync(dest);
  else if (existing) throw new Error(`${dest} exists and is not a symlink; remove it first`);
  fs.symlinkSync(path.join(ROOT, "skills", "quiz"), dest);
  return dest;
}

export function installCodex(home: string): string[] {
  const file = path.join(home, ".codex", "hooks.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const json: HooksFile = fs.existsSync(file)
    ? (JSON.parse(fs.readFileSync(file, "utf8")) as HooksFile)
    : {};
  const hooks = (json.hooks ??= {});
  for (const [event, arg] of [
    ["UserPromptSubmit", "user-prompt"],
    ["Stop", "stop"],
  ] as const) {
    // Drop earlier agent-teacher entries (e.g. from an old checkout path), keep everything else.
    const groups = (hooks[event] ?? [])
      .map((g) => ({ ...g, hooks: g.hooks.filter((h) => !isOurs(h)) }))
      .filter((g) => g.hooks.length > 0);
    groups.push({
      hooks: [{ type: "command", command: `node "${CORE}" hook ${arg}`, timeout: 10 }],
    });
    hooks[event] = groups;
  }
  fs.writeFileSync(file, JSON.stringify(json, null, 2) + "\n");
  const notes = [`wrote hooks to ${file}`, `linked skill at ${linkSkill(home)}`];
  const toml = path.join(home, ".codex", "config.toml");
  const tomlText = fs.existsSync(toml) ? fs.readFileSync(toml, "utf8") : "";
  if (!/^\s*(hooks|codex_hooks)\s*=\s*true/m.test(tomlText))
    notes.push(`ACTION: add "hooks = true" under [features] in ${toml}`);
  notes.push("ACTION: start codex and run /hooks to review and trust the two agent-teacher hooks");
  return notes;
}

export function installOpencode(home: string): string[] {
  const base = path.join(home, ".config", "opencode");
  const plugin = path.join(base, "plugins", "agent-teacher.ts");
  const command = path.join(base, "commands", "quiz.md");
  fs.mkdirSync(path.dirname(plugin), { recursive: true });
  fs.mkdirSync(path.dirname(command), { recursive: true });
  // Remove the shim from before the rename so the plugin isn't loaded twice.
  fs.rmSync(path.join(base, "plugins", "agent-quiz.ts"), { force: true });
  fs.writeFileSync(
    plugin,
    `// installed by agent-teacher (${ROOT})\nexport { default } from ${JSON.stringify(path.join(ROOT, "adapters", "opencode", "plugin.ts"))};\n`,
  );
  // The command expands "/quiz on" to "quiz on", which the plugin recognizes.
  fs.writeFileSync(
    command,
    "---\ndescription: Toggle agent-teacher mode (on, off, status, review)\n---\nquiz $ARGUMENTS\n",
  );
  return [
    `wrote plugin ${plugin}`,
    `wrote command ${command}`,
    `linked skill at ${linkSkill(home)}`,
    "ACTION: restart opencode",
  ];
}

const TARGETS: Record<string, (home: string) => string[]> = {
  codex: installCodex,
  opencode: installOpencode,
};

const invokedDirectly = (() => {
  try {
    return fs.realpathSync(process.argv[1] ?? "") === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  const targets = process.argv.slice(2);
  if (targets.length === 0 || targets.some((t) => !(t in TARGETS))) {
    console.error(
      "usage: node install.ts codex|opencode [...]\n(Claude Code: see README, installs via /plugin)",
    );
    process.exit(2);
  }
  for (const t of targets)
    for (const line of TARGETS[t]!(os.homedir())) console.log(`${t}: ${line}`);
}
