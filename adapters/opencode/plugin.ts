// opencode adapter for agent-quiz. opencode has no hook that returns context,
// so chat.message runs the shared handler (which applies toggles) and stashes
// its text; the system-prompt transform for that session's LLM call injects it.
// session.idle stands in for Claude Code's Stop hook.

import type { Plugin } from "@opencode-ai/plugin";
import { handleStop, handleUserPrompt } from "../../core/quiz.ts";

export const AgentQuiz: Plugin = async ({ client, directory }) => {
  const pending = new Map<string, string>();

  return {
    "chat.message": async (input, output) => {
      const prompt = output.parts
        .flatMap((p) => (p.type === "text" && !p.synthetic ? [p.text] : []))
        .join("\n");
      const context = handleUserPrompt({ sessionId: input.sessionID, prompt, cwd: directory });
      if (context) pending.set(input.sessionID, context);
    },

    "experimental.chat.system.transform": async (input, output) => {
      if (!input.sessionID) return;
      const context = pending.get(input.sessionID);
      if (!context) return;
      pending.delete(input.sessionID);
      output.system.push(context);
    },

    event: async ({ event }) => {
      if (event.type !== "session.idle") return;
      const sessionID = event.properties.sessionID;
      const reason = handleStop({ sessionId: sessionID, cwd: directory, stopHookActive: false });
      if (!reason) return;
      await client.session.prompt({
        path: { id: sessionID },
        body: { parts: [{ type: "text", text: reason }] },
      });
    },
  };
};

// opencode 2.x requires a default definition with an id; `server` carries the hooks above.
export default { id: "agent-quiz", server: AgentQuiz, setup() {} };
