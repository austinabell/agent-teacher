---
name: quiz
description: Toggle agent-quiz mode for this session (quiz on, quiz off, quiz status, quiz review). Use when the user types one of these commands.
---

The agent-quiz hook handles this command before you see it and adds a message starting with `[agent-quiz]` to your context. Follow that message.

If no `[agent-quiz]` message is in your context for this prompt, the hooks are not installed or not trusted. Tell the user in one line and point them to the agent-quiz README install section.
