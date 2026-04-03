# Purpose

This document is about building a agent-2-agent communication system using our existing messaging system.

# Structure

First, read this document in detail: `documents/pi-a2a-communication.md` to understand how the messaging system works.

Here's the takeaway:
- Any agents coming together can form a team, which has a unique channel for communication, and this channel has its own dedicated sqlite3 database.
- The agent-2-agent communication only relies on 2 tables of sqlite3: `messages` and `agent_cursors`.

# What we should do next:

## Each agent should have a persona

We will consider that for each agent, we should put a `persona.yaml` file in its cwd folder, which describes the persona of this agent.

```yaml
name: "Code Reviewer"
description: "You are a code reviewer. You are responsible for reviewing the code and providing feedback to the developer."
folder_access:
  write:
    - "/home/user/code/project1"
    - "/home/user/code/project2"
  read:
    - "/home/user/code/project3"
    - "/home/user/code/project4"
```

Each agent is supposed to have a clear "boundary" of what it can do and what it can not do. We often found `pi` aggresively search files to read, but in many cases, it is not necessary.

The `name` and `description` fields should be broadcasted to all other agents in the team. Other agents (teammates) will know what you can do by reading the `description` field.

skills and mcp are fine, which is the agent's own equipment, which its teammates do not need to know.

** Important: ** the `description` field is missing in the `agents` table, and you need to add it.

## A2A communication

All inter-agent communication should be done via the `messages` table. The `agent_cursors` table is only used for agents to remember which messages they have read. BTW, please also add a new field `is_read` (tinyint) to the `messages` table, indicating whether the message has been read by the recipient, or by all the recipients if it's a broadcast message.

### DM vs BM
If `to_agent` is not `null`, it's a direct message to the specified agent. If `to_agent` is `null`, it's a broadcast message to all agents in the team.

When the sender agent sends a non-broadcast message, it should create ONE row in the `agent_cursors` table for the recipient agent (identified by `session_id`, which must be the same as the `to_agent` field in the message).

When the sender agent sends a broadcast message, it should create N rows in the `agent_cursors` table for all the recipient agents (identified by `session_id`, which must be the same as the `to_agent` field in the message).

## Message Definition and how to respond

Now we know how the agents can communicate by sending and reading messages. Next is to define the message types and how to respond to them.

First, remove this field from the `messages` table which is no longer necessary, because everything can be controled in the payload body:
```sql
type TEXT NOT NULL CHECK (type IN ('prompt', 'pause', 'continue', 'close')),
```
also, the `status` field in the `agents` should be active|idle|inactive.

Now let's define the payload body, which is a JSON object with the following fields:
- event: enum; could be the following
  - "broadcast": this is a broadcast message to all agents. no need to reply (no task_ack or all followups)
  - "info_only": this is an info-ony message to a specific agent. no need to reply (no task_ack or all followups)
  - "ping": ask a specific agent. If "pong" message is not received within 20 seconds, then the sender will change the recipient agent's status to "inactive".
  - "pong": acknowledgement of the "ping" message.
  - "task_req": sender agent sends a task request to the recipient agent, and the recipient agent should respond with a task response.
  - "task_ack": recipient agent sends a task acknowledgement back to the sender agent.
  - "task_ask_req": recipient agent asks the sender agent for more information about the task.
  - "task_ask_res": sender agent sends a task more information acknowledgement to the recipient agent.
  - "task_update": sender agent sends a task update in progress to the recipient agent.
  - "task_cancel": sender agent sends a task cancellation request to the recipient agent.
  - "task_cancel_ack": recipient agent sends a task cancellation acknowledgement back to the sender agent.
  - "task_done": sender agent sends a task done response to the recipient agent.
  - "task_fail": sender agent sends a task failure response to the recipient agent.
- need_reply: boolean; if true, the recipient agent should respond to the message. if false, the recipient agent need not to reply (e.g. broadcast, info_only)
- content: string; shouldn't be too long, max 500 characters.
- detail: string; must be an aboslute file path, which the other agent is supposed to read (it may contain more files to read further). Normally we should put task result (task_done) in this field. If the message is short and `content` is enough to describe the task, this field should be `null`.

Based on the above message event, the recipient agent should respond approriately unless `need_reply` is false.