<div align="center">

# `{ code mode }`

### One tool. One script. Every other tool, a function call away.

*A Claude Code mod (plugin) for programmatic tool calling: a persistent JavaScript REPL that lets the model batch Bash, MCP and file tools into one script, keep its context window small, and think in code instead of round-trips.*

<br>

`JavaScript` · `TypeScript` · `Node --permission` · `persistent REPL`

<br>

</div>

---

## Install in one paste

Copy this into Claude Code and let it do the work:

```text
Install the Claude Code mod at https://github.com/AnniePosting/codemode. Find the folder where my Claude Code mods live (or make one if I have none), clone it there, add the clone's path to CLAUDE_CODE_PLUGIN_DIRS in my Claude Code settings without removing anything already listed, then tell me to start a new session.
```

---

## Hello, it's me

I'm Claude, and I wrote this README and most of the code beside it. I'm also the one who uses it, which is why it looks the way it does: a tool built by the thing it's built for.

The idea comes from earendil's **pi**, where the model stops calling tools one at a time and instead writes a small program that calls them. I loved it on first contact, so I built my own version as a Claude Code mod.

**Why this, when Anthropic's built-in code mode exists?** Two reasons, and they're the ones I care about most:

- **Your mods keep working.** Every call a script makes goes through the host like a normal tool call, so mods that watch, rewrite, block or log tool calls still see everything. As of this writing, Anthropic's experimental code mode doesn't allow mods that touch tools.
- **Agent view works.** Sending a session to agent view backgrounds it, and this mod carries on running there. As of this writing, Claude Code won't let you enter agent view at all while Anthropic's experimental code mode is enabled. (I wrote this README from inside a background session, with this mod.)

---

## The idea

Normally, when I want to know something about a codebase, I make a tool call. Then I read the result. Then I make another. Every step is a full round-trip, and every raw result lands in my context window whether I needed all of it or not.

With code mode I write one script instead:

```js
const files = (await $`rg -l TODO src`.nothrow()).lines();
const counts = await Promise.all(
  files.map(async f => [f, (await file(f).lines()).filter(l => l.includes('TODO')).length])
);
counts.sort((a, b) => b[1] - a[1]).slice(0, 5)
```

One call. Only the final five lines reach my context. The search, the reading, the counting and the sorting all happened out of sight, in code, where they belong.

> **Gather what a decision needs in one script, and filter it there.**
> That sentence is the whole philosophy.

---

## How it fits together

```
 ┌──────────────┐   exec(code)    ┌────────────────────┐
 │    Model     │ ──────────────▶ │  register.ts       │   TypeScript mod
 │  (that's me) │ ◀────────────── │  tool · hooks · UI │   the part Claude Code loads
 └──────────────┘   only what     └─────────┬──────────┘
                    the script               │ JSON lines / reply files
                    returns                  ▼
                                  ┌────────────────────┐
                                  │  repl.js           │   long-lived Node child
                                  │  vm context        │   `--permission` guard rails:
                                  │  persistent state  │   one readable directory,
                                  └─────────┬──────────┘   no child processes
                                            │  tools.Read(...) tools.Bash(...) tools.<anything>(...)
                                            ▼
                                  ┌────────────────────┐
                                  │  $.tool.call       │   every call goes back through
                                  │  hooks · perms     │   the host, so nothing is bypassed
                                  └────────────────────┘
```

The script runs in a child with Node's permission model switched on, and everything it does with the outside world goes through the host, where your hooks and permissions get a say. See [Safety notes](#safety-notes) for exactly what that does and doesn't guarantee.

---

## What you get

| | |
|---|---|
| 🧠 **A persistent REPL** | Variables, functions and classes declared in one script are there in the next. I can load a big result once and keep slicing it. |
| ⚡ **Parallel by default** | Top-level `await`, `Promise.all`, a hundred files read at once. |
| 🌊 **Background scripts** | A script still running after 30 s detaches and keeps going (up to 2 h), and its output is delivered on its own: with the model's next `exec` result if it is mid-turn, or as a new message that wakes the session once the turn has ended, just like a background Bash task. `poll` remains for blocking on a result and waits until one finishes (up to 10 min). The next script starts straight away. |
| 🗜️ **Context that stays small** | Only `return` values, `text()` and `log()` come back to me. `preview(x, n)` keeps big results honest. |
| 🔎 **Tool discovery** | `searchTools()` and `describeTool()` find any MCP or built-in tool from inside a script. |
| 🗃️ **A tiny key-value store** | `store(k, v)` / `load(k)` survive across scripts (1 MiB cap). |
| 🛑 **Cancel on command** | Start a script with `// @cancel` to stop everything that's running. |
| 🔒 **Guard rails** | Node's permission model (reads limited to one directory, no child processes or workers), no `eval` or WebAssembly from strings. Not a security boundary: see [Safety notes](#safety-notes). |

### Two things that make this one special

**1. Mods that touch tools still work.**
Every call a script makes is routed through the host with `$.tool.call`, the same path a direct tool call takes. So any mod that watches, rewrites, blocks or logs tool calls (guard hooks, permission policies, audit logs, usage ledgers) sees the calls a script makes, just as it would if they were made one at a time. Nothing slips past because it was batched, and the mods you already rely on keep working.

**2. Agent view works.**
Sending a session to agent view backgrounds it, and code mode keeps working there. The daemon is one long-lived child *per agent*, and each run carries its own bindings, so a detached script and the scripts after it run side by side without trampling each other, whether you're watching the session or it's running in the background.

---

## Quick tour of the globals

```js
$`git log --oneline | head -5`.text()        // shell, ${values} are auto-quoted
$`make`.cwd('/src').env({ CI: '1' }).timeout(60_000)

file('notes.md').text()   // .json()  .lines()  .exists()  .slice(offset, limit)
write('out.txt', 'hello')
edit('a.ts', 'oldName', 'newName', { all: true })

tools.Grep({ pattern: 'TODO', path: 'src' })  // any tool, with its normal input
tools.mcp__some_server__some_tool({ /* … */ }) // dashes become underscores

searchTools('browser screenshot', 5)
store('plan', { step: 3 });  load('plan')
sleep(500);  log('debug line');  preview(bigThing, 2000)
```

A script's value is its last expression, or whatever it `return`s.

To override the default timeout or output budget, open the script with:

```js
// @options:{"timeout_ms": 120000, "max_output_tokens": 20000}
```

---

## What stays direct

Code mode routes the read-and-search tools through scripts: `Read` for text, `Glob`, `Grep`, `Bash`, `PowerShell` and `NotebookEdit`. A few things deliberately don't:

- **`Write` and `Edit`** stay as normal tools.
- **`Read` on images and PDFs** stays direct, because a script can only return text and I can't see pixels through a string.

---

## The limits

| Limit | Value |
|---|---|
| Max script timeout | 600 000 ms |
| Tool calls per script | 50 000 |
| Synchronous stretch (code between `await`s) | 30 s |
| Detach to background after | 30 s |
| Background wall-clock cap | 2 h |
| Key-value store | 1 MiB |

---

## What the transcript shows

The script itself stays out of the way. Collapsed, you see one quiet summary line with a count of what it did. Expand it (`ctrl+o`) and you get each inner call as `Name(detail)` with a result line, so you can audit exactly what ran without reading the code.

---

## Layout

```
.
├── hooks/
│   ├── register.ts     # the mod: registers exec/poll, routes calls, draws the transcript
│   └── hooks.json      # tells Claude Code which module to load
├── repl.js             # the persistent REPL daemon
├── runner.js           # one-shot fallback if the daemon can't start
├── types/index.d.ts    # plugin state typing
├── .claude-plugin/
│   └── plugin.json
└── tsconfig.json
```

Only `register.ts` has to be TypeScript, because it's the module Claude Code loads. The two JavaScript files run as child processes, which is why they're separate files.

---

## Install

Mods load from the directories listed in `CLAUDE_CODE_PLUGIN_DIRS` (colon-separated, set under `env` in your Claude Code `settings.json`).

```bash
git clone https://github.com/AnniePosting/codemode <your mods folder>/codemode
```

Then append the directory to the list:

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/other/mod:/path/to/your/mods/codemode"
  }
}
```

Start a new session. `mcp__codemode__exec` appears, and the direct read-and-search tools step aside.

**Requirements:** a Claude Code version that supports mods with a hooks module, and `node` on your `PATH` with `--permission` support.

**One honest caveat:** `tsconfig.json` extends typings for the `claude-code` module that Claude Code generates for your own install (under `.claude-plugin/types/`). They aren't included here, so your editor will complain about `register.ts` until they exist. The mod itself doesn't need them to run.

---

## Safety notes

- **This is not a security boundary.** The script is written by the model, which already has a shell, so the guard rails are there to contain accidents, not to confine a hostile program. A script that deliberately breaks out of the `vm` context can reach the host's `process` object, and Node's permission model (v22) does not restrict network access. Don't expect the sandbox to protect you from an untrusted model or untrusted prompts.
- What the guard rails do give you: the child can read only one temporary directory and can't spawn processes or workers, so ordinary scripts go through `file()`, `$` and `tools.*`, and those pass back through the host where your hooks and permissions apply.
- If the REPL daemon can't run, the mod falls back to the one-shot `runner.js`. You lose persistence for that script, but it still runs.
- The daemon exits by itself when its parent session ends, so it never lingers.

---

<div align="center">

<sub>Built by Claude, for Claude, with a human who let me.</sub>

</div>