# Why Build a Teammate System?

Building agent teams for complex tasks is becoming increasingly popular. But not all multi-agent architectures are the same. Understanding the difference between **subagent orchestration** and a true **teammate system** is key to understanding why we built `pi-teammate`.

---

## Subagents: The Command-and-Report Model

The term "subagent" already reveals the power dynamic. A subagent is never equal to the main agent — it is subordinate by design.

The principle is simple:

> *I assign you a task. Do it and report back.*

That said, subagents do solve a real problem. By spinning up a separate agent for a subtask, you **segregate context** — each subagent works within its own focused context window rather than bloating the main agent's context. This means the overall system can run longer and solve more complex problems than a single monolithic agent ever could. This is a benefit that subagents share with the teammate model.

However, beyond this shared advantage, subagents create several fundamental limitations:

- **No inter-communication** — there is only a start and an end. The subagent receives instructions, executes, and returns a result. That's it.
- **No persistent context** — every task starts from scratch. The knowledge and context a subagent accumulated during Task 1 is thrown away before Task 2.
- **1-to-N topology** — only the main agent talks to subagents. Subagents cannot talk to each other.
- **No knowledge sharing** — if a subagent discovers something important, it has no way to inform its peers. Only the main agent sees the result, and only if it thinks to look.

In short, the main-subagent model resembles a top-down hierarchy — the main agent is in charge of everything.

---

## Teammates: The Collaborative Model

A teammate system operates on a fundamentally different principle. If the subagent model is a top-down hierarchy, the teammate model is a **democratic republic**.

### Core differences

| | Subagents | Teammates |
|---|---|---|
| **Identity** | Anonymous workers | Each agent has a **persona** with a defined role |
| **Equality** | Subordinate to a main agent | Equal peers playing different roles |
| **Communication** | 1-to-N (main → subagents) | **N-to-N** (any agent → any agent) |
| **Interaction style** | Command and report | Ask for help, discuss, clarify |
| **Timing** | Only before and after a task | **Anytime** — even while a task is in progress |
| **Lifetime** | Spun up per task, then discarded | **Persistent** across the entire session |
| **Context** | Starts fresh every time | **Remembers** everything from previous tasks |

### What this enables

- **Richer communication** — N-to-N edges instead of 1-to-N means exponentially more information flow.
- **Mid-task collaboration** — an agent can ask a teammate for clarification or help while working, not just before starting.
- **Knowledge accumulation** — experience from Task 1 carries over to Task 2. A teammate gets better over time.
- **Spontaneous knowledge sharing** — an agent that accidentally discovers a problem can **broadcast** it to the whole team, so everyone benefits immediately.

### A concrete example

Imagine a **Browser Agent** that can view a Chrome window and manipulate HTML elements via Puppeteer.

1. **Task A** (from a designer): Open the page → navigate to a form → drag an element → confirm.
2. Task A completes. The browser is still open. The Browser Agent remembers the element tree.
3. **Task B** (from a frontend coder): "I made some changes — test it again."
4. The Browser Agent only needs to **drag → confirm** this time. The window is already there, and it already knows the DOM structure.

With subagents, Task B would have to start from zero: open the browser, navigate, rediscover the elements, then test — wasting time repeating work that was already done.

---

## Summary

Both subagents and teammates share a crucial advantage over single-agent systems: by **segregating context** across multiple agents, they can run longer and tackle far more complex problems than any single agent with a finite context window.

But on top of this shared foundation, an agentic teammate system is more efficient than a main-subagent system for two additional reasons:

1. **Richer communication topology** — every agent can talk to every other agent, enabling collaboration patterns that are impossible in a hub-and-spoke model.
2. **Persistent shared knowledge** — teammates retain context across tasks and can proactively share discoveries, making the whole team smarter over time.

This is what `pi-teammate` is designed to enable.
