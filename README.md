# Herdr mods

Two personal mods for the [Herdr](https://herdr.dev) desktop app. They are not
part of Herdr and upstream does not ship them — you copy a folder into your own
mods folder and Herdr runs it.

| Mod | What it does |
|---|---|
| [`agent-restore/`](agent-restore/) | Brings your agents back after a restart: Claude Code, Codex — anything that reported its session — come back with the conversation they had. |
| [`claude-sessions/`](claude-sessions/) | Lists the Claude Code sessions on this machine and reopens one where it ran. |

Both are plain JavaScript for Herdr's mod API; there is nothing to compile.

## Install

Copy the folder you want into Herdr's mods folder:

- Linux, macOS: `~/.config/herdr-app/mods/`
- Windows: `%USERPROFILE%\.config\herdr-app\mods\`

```sh
git clone https://github.com/cifilaci/herdr-mods.git
cp -r herdr-mods/agent-restore ~/.config/herdr-app/mods/
```

Herdr picks the mod up on its next start. To check a mod before you trust it,
load it once and let it render:

```sh
herdr-app check ~/.config/herdr-app/mods/agent-restore
```

`check` writes `gpui-kit.d.ts` and `jsconfig.json` next to the mod — those are
generated type stubs, not sources. Delete them if you do not want them.

Herdr's own guide, written into `~/.config/herdr-app/AGENTS.md` on every start,
documents the mod API these use.

---

## agent-restore — the agents come back after a restart

A kept terminal comes back after a reboot or a core crash as a **plain shell**:
its program is never run again, so the agent in it is gone. This mod puts the
agent back.

**How it works.** Each agent reports its session id to Herdr as a terminal
label (`herdr.resume.claude={"session_id":"…"}`). When a restart happened, the
mod types the agent's resume command into the recovered shell — `claude
--resume <session>`, `codex --no-daemon resume <session>` — and the agent
comes back with its conversation.

**When it acts.** Only when it can show that a restart happened, and the
evidence is one thing: **the running core recovered that terminal**. A
recovered terminal keeps the `created_ms` it always had, so it is older than
the core that recovered it; a terminal the running core created is newer. That
comparison is the whole rule.

So a terminal whose agent simply died mid-session — a crash, a `kill -9` — is
left alone, even at the next start of Herdr. That is deliberate: the mod
resumes only what a restart actually took away.

**How to start it.** The mod does nothing until a layout carries its block.
Clone the layout you boot into and add the block to the clone's root:

```sh
herdr-app do layout.clone '{"name":"main","as":"my-layout"}'
```

```json
{"type": "block", "size": {"px": 0}, "content": {"mod": "agent-restore"}}
```

Then `herdr-app do layout.switch '{"name":"my-layout"}'`. The block takes no
room. The restore runs in the layout that carries the block, so a layout
without it has no restore.

**How to install the hook.** Open the mod's overlay — `herdr-app do mod.open
'{"name":"agent-restore"}'`, or bind a key to `mod.open:agent-restore` — and
press **Install**. That writes:

- `~/.claude/skills/herdr-resume/` for Claude Code (a plugin with the hook),
- its own entry in `~/.codex/hooks.json` for Codex.

It writes nothing else of yours, and the mod's own entries are what **Remove**
takes away again. The hook takes effect for the next agent you start.

**What it touches.** Only the files above, and only to read the agent's own
configuration. It runs `hc` and the platform's shell to ask the core about its
terminals and to type the command.

**Told to the person.** The mod says what it did: *"Sent the resume command
for Claude Code"*, and — if the agent never reports within fifteen seconds —
*"Claude Code did not start"*. Nothing is retried; you decide.

---

## claude-sessions — browse your Claude Code sessions

Claude Code keeps one JSONL transcript per session under
`~/.claude/projects/<project-slug>/<session-id>.jsonl`, and every prompt it
received in `~/.claude/history.jsonl`. This mod lists those sessions — title,
folder, prompt count, when it was last used — and reopens one **where it ran**:
into the space of the terminal that carried it, else into the space of its
project, else into a new space on this computer.

A transcript runs to tens of megabytes, so it is never read whole: the listing
is a shallow walk of the project folders, the history is read from its tail,
and a session the history does not know costs one bounded head read.

**How to open it.** Bind a key to it in `~/.config/herdr-app/keys.json`:

```json
"ctrl-shift-s": "mod.open:claude-sessions"
```

Then `ctrl-shift-s` opens the overlay.

**What it touches.** It reads your Claude Code configuration
(`CLAUDE_CONFIG_DIR`, or `~/.claude`) and runs a short listing command —
PowerShell on Windows, `sh` elsewhere. It writes nothing.

---

## Where these files come from

Both mods are developed inside the [herdr-app](https://github.com/herdrdev/herdr-app)
project — the app they plug into — where they live under `defaults/mods/` and
are covered by that project's own test suite. This repository holds the
published copy, refreshed when a mod changes. The copies published here were
taken at `6683be4` (agent-restore) and `f0fcac8` (claude-sessions).

## Licence

Apache License 2.0, the same licence as
[herdr-app](https://github.com/herdrdev/herdr-app). See [LICENSE](LICENSE).
