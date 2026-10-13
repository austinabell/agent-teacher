---
name: teach
description: Toggle agent-teacher mode for this session (teach on, teach quiz, teach write, teach off, teach status, teach review). Use when the user types one of these commands.
---

The agent-teacher hook handles this command before you see it and adds a message starting with `[agent-teacher]` to your context. Follow that message.

If no `[agent-teacher]` message is in your context for this prompt, the hooks are not installed or not trusted. Tell the user in one line and point them to the agent-teacher README install section.
