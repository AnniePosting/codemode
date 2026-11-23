import type { Register } from 'claude-code'

// Code mode, after earendil's pi: the model writes the body of an async JS
// function; it calls the session's tools as tools.<name>(input) and only what it emits (text(), return) reaches
// the model. The module cannot compile code (no eval), so a node child runs it under --permission; each call it
// prints is answered here through $.tool.call, so hooks and permissions still apply.
//
// Design: Read, Glob, Grep, Bash, PowerShell and NotebookEdit are the
// code-mode-only tools (hidden from the model, reached only from a script); Write and Edit stay direct. Limits:
// 600000 ms maximum timeout, 50000 tool calls per script, 30 s synchronous run (the 30000 is its wall clock, not an output cap). Bindings persist
// between scripts (repl.js is one long-lived context); runner.js is the one-shot fallback if the daemon cannot run.
const EXEC = 'mcp__codemode__exec'
const POLL = 'mcp__codemode__poll'
const NOT_NESTED = new Set([EXEC, POLL])
const isNested = (tool: string) => NOT_NESTED.has(tool) || /^mcp__[^_]+__new_context$/.test(tool) // a script must not start a new context window
const STORE = { plugin: 'codemode', key: 'store' } as const
const STORE_MAX = 1048576
const MAX_TOKENS = 10000
const MAX_TIMEOUT_MS = 600000
const TOOL_CALL_CAP = 50000
const DETACH_MS = 30000 // a script still running after this is detached to the background
const ASYNC_WALL_CAP_MS = 7200000 // and may run this long
const SYNC_MS = 30000 // a script's synchronous stretch is stopped after this
const POLL_MAX_MS = 600000 // poll blocks until a background script finishes, at most this long
const HIDDEN = new Set(['Glob', 'Grep', 'Bash', 'PowerShell', 'NotebookEdit'])
// Read is the one hidden tool with a carve-out: a script only gets text back, so images (screenshots) and PDFs can only be seen through a direct Read call.
const VISUAL = /\.(png|jpe?g|gif|webp|bmp|heic|avif|pdf)$/i
const isVisualRead = (e: any) => (e.tool ?? e.name ?? e.toolName) === 'Read' && VISUAL.test(String(e.file_path ?? e.input?.file_path ?? e.path ?? ''))
const FORCE = true // false: nothing is hidden or denied, exec is just one more tool
let ready = false // set once exec is registered: never hide or deny tools without it
const agentKey = (e: any) => String(e.agentId ?? 'main')

// ---- display only: what the transcript shows for an exec call (the script itself stays in the tool input) ----
// The transcript hides the script and lists each inner call as its own entry under a grey count line; the plugin API
// cannot make an engine entry per call, so the exec row is redrawn (ui.render) from a log of the calls the script made.
type Call = { label: string; detail: string; out: string; kind: 'search' | 'read' | 'shell' | 'edit' | 'scratch' | 'other'; err: boolean; added: number }
const opened = new Set<string>() // exec rows the person opened by clicking the summary line
const logs = new Map<string, Call[]>() // exec's tool_use_id -> its inner calls, in completion order
const LOG_KEEP = 200
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
const oneLine = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim()
const lineCount = (s: string) => (s ? s.replace(/\n$/, '').split('\n').length : 0)
const plural = (n: number, w: string, ws = w + 's') => `${n} ${n === 1 ? w : ws}`
const SCRATCH = /\/scratchpad\//
const unq = (s: string) => s.replace(/^'(.*)'$/s, '$1').replace(/'\\''/g, "'")
export function describeCall(tool: string, input: any, text: string, err: boolean): Call | null {
  const i = input ?? {}
  const base = { out: '', err, added: 0 }
  // file() and its slice() run over Bash (cat, sed -n, test -e): they are shown as Read entries, and exists() as nothing.
  if (tool === 'Bash' && typeof i.command === 'string') {
    const cmd = i.command as string
    const cat = /^cat -- ('(?:[^']|'\\'')*')$/s.exec(cmd)
    const sed = /^sed -n '(\d+),(\d+)p' -- ('(?:[^']|'\\'')*')$/s.exec(cmd)
    if (/^test -e '/.test(cmd)) return null
    if (cat) return { ...base, kind: 'read', label: 'Read', detail: unq(cat[1]!), out: err ? 'Error: ' + text : `Read ${plural(lineCount(text), 'line')}` }
    if (sed) return { ...base, kind: 'read', label: 'Read', detail: `${unq(sed[3]!)} · lines ${sed[1]}-${sed[2]}`, out: err ? 'Error: ' + text : `Read ${plural(lineCount(text), 'line')}` }
  }
  if (tool === 'Glob' || tool === 'Grep') {
    const n = lineCount(text.trim())
    const found = text.trim() === '' || /^no (files|matches)/i.test(text.trim()) ? 'No matches found' : tool === 'Glob' ? `Found ${plural(n, 'file')}` : `Found ${plural(n, 'line')}`
    return { ...base, kind: 'search', label: 'Search', detail: `pattern: "${clip(oneLine(i.pattern), 80)}"${i.path ? `, path: "${i.path}"` : ''}`, out: err ? text : found }
  }
  if (tool === 'Read') {
    const lines = i.offset || i.limit ? ` · lines ${i.offset ?? 1}-${(i.offset ?? 1) + (i.limit ?? 1) - 1}` : ''
    return { ...base, kind: 'read', label: 'Read', detail: `${i.file_path ?? ''}${lines}`, out: err ? text : `Read ${plural(lineCount(text), 'line')}` }
  }
  if (tool === 'Bash' || tool === 'PowerShell') {
    const o = text.replace(/\s+$/, '').split('\n')
    const shown = o.slice(0, 3).join('\n')
    return { ...base, kind: 'shell', label: tool, detail: clip(oneLine(i.command), 160), out: err ? 'Error: ' + clip(text, 400) : o.length > 3 ? `${shown}\n… +${o.length - 3} lines` : shown }
  }
  if (tool === 'Write') {
    const n = lineCount(String(i.content ?? ''))
    return { ...base, kind: SCRATCH.test(String(i.file_path)) ? 'scratch' : 'edit', label: 'Write', detail: String(i.file_path ?? ''), out: err ? text : `Wrote ${plural(n, 'line')} to ${i.file_path}`, added: String(i.content ?? '').split('\n').length }
  }
  if (tool === 'Edit' || tool === 'NotebookEdit') {
    const p = String(i.file_path ?? i.notebook_path ?? '')
    return { ...base, kind: SCRATCH.test(p) ? 'scratch' : 'edit', label: tool === 'Edit' ? 'Update' : tool, detail: p, out: err ? text : `Updated ${p}`, added: lineCount(String(i.new_string ?? '')) }
  }
  const short = tool.replace(/^mcp__([^_]+(?:_[^_]+)*?)__/, '$1 - ')
  return { ...base, kind: 'other', label: short, detail: clip(oneLine(JSON.stringify(i)).replace(/^{|}$/g, ''), 120), out: err ? text : clip(oneLine(text), 160) }
}
// "Made 1 scratchpad edit +4, searched for 4 patterns, read 1 file, ran 2 shell commands"
export function summarise(calls: Call[]): string {
  const k = (x: Call['kind']) => calls.filter((c) => c.kind === x)
  const parts: string[] = []
  const sc = k('scratch'), ed = k('edit')
  if (sc.length) parts.push(`made ${plural(sc.length, 'scratchpad edit')} +${sc.reduce((a, c) => a + c.added, 0)}`)
  if (ed.length) parts.push(`edited ${plural(ed.length, 'file')} +${ed.reduce((a, c) => a + c.added, 0)}`)
  if (k('search').length) parts.push(`searched for ${plural(k('search').length, 'pattern')}`)
  if (k('read').length) parts.push(`read ${plural(k('read').length, 'file')}`)
  if (k('shell').length) parts.push(`ran ${plural(k('shell').length, 'shell command')}`)
  if (k('other').length) parts.push(`called ${plural(k('other').length, 'tool')}`)
  const s = parts.join(', ')
  return s ? s[0]!.toUpperCase() + s.slice(1) : ''
}

export const DESCRIPTION = `Write JavaScript that drives the session's other tools. This is how you read files, search, run shell commands and call MCP tools: put the work in a script, and only what the script returns or logs comes back to you, so do your filtering inside it.
The script is the body of an async function (top-level await works) and it runs in a context that persists: anything you declare with const, let, var, function or class is still there in the next script, until the session restarts or resumes. There is no import, require or process. The result is the value of the final expression or an explicit return, plus whatever you log(). Park large results in a variable and return preview(x, 2000).
Available inside a script:
- $\`cmd\` runs a shell command; interpolated \${values} are quoted for you. Chain .text(), .lines(), .json(), .nothrow(), .timeout(ms), .cwd(dir), .env({...}).
- file(path) gives .text(), .json(), .lines(), .exists() and .slice(offset, limit). write(path, content) writes. edit(path, old, new, {all, soft}) or edit(path, [[old, new], ...]) replaces text.
- tools.<name>(input) calls any tool with the input it normally takes. Characters that are not valid in an identifier become _, so mcp__a-b__c is tools.mcp__a_b__c. tools.Glob and tools.Grep exist (ripgrep).
- searchTools(query, max) and describeTool(name) find tools; sleep(ms); log(...); text(x); preview(x, n); store(key, value) and load(key); running() lists scripts and abort() stops one; setTimeout and setInterval (they stop when the script ends); console.* goes to a ring buffer that console.tail(n) reads back.
Everything that touches the outside world returns a promise, so await it (file(p).text() is a promise, not a string). Large tool results arrive whole.
Scripts begin in the order sent. One that runs longer than ${DETACH_MS / 1000}s moves to the background (it may live up to ${ASYNC_WALL_CAP_MS / 3600000} h): the call returns at once, the next script starts alongside it with the same variables, and its output is saved to a file and delivered to you on its own: with your next exec result if you are mid-turn, or as a new message that wakes you if you have ended your turn. So do not poll in a loop: do other work or end your turn. Call ${POLL} only when you must block on the result; it waits until a background script finishes (up to ${POLL_MAX_MS / 60000} min). \`timeout\` caps a script's own running time in ms (default 30000, max ${MAX_TIMEOUT_MS}); time spent waiting on tool calls does not count. A script may make ${TOOL_CALL_CAP} tool calls, and any synchronous stretch (code between awaits) is cut off after ${SYNC_MS / 1000}s. A first line of \`// @cancel\` aborts every running script but keeps your variables. Skills load through the Skill tool, not from a script.
Example: const hits = (await $\`rg -l FIXME src\`.nothrow()).lines(); ({total: hits.length, sample: hits.slice(0, 5)})`

const GUIDANCE = `Code mode is active. Bash, Glob, Grep, PowerShell, NotebookEdit and Read-for-text are not available as direct calls; route that work through ${EXEC} scripts (shell with $\`...\`, files with file(), write() and edit(), anything else with tools.<name>()). Variables persist between scripts, so collect what a decision needs in one script and return only that. One exception: Read on an image (screenshot, png, jpg, gif, webp) or a PDF is called directly, because a script can only return text, not pixels. A script that outlasts ${DETACH_MS / 1000}s moves to the background; its result is delivered to you automatically (with your next exec result, or as a new message once your turn has ended), so never poll in a loop.`

export function parse(src: string): { code: string; opts: { max_output_tokens?: number; timeout_ms?: number } } {
  const m = /^\/\/ @options:(.*)\n?/.exec(src)
  if (!m) return { code: src, opts: {} }
  try { return { code: src.slice(m[0].length), opts: JSON.parse(m[1] ?? '') } } catch { throw new Error('the @options line is not valid JSON') }
}

export const ident = (name: string) => name.replace(/[^A-Za-z0-9_$]/g, '_')

// Pi's result shape: "Script completed|failed" and wall time, the emitted items, a console block, the error.
export function format(r: { out: string[]; logs: string[]; error?: string }, secs: number, maxTokens: number, spill: string) {
  const parts = r.out
  let body = parts.join('\n')
  if (r.logs.length) body += `${body ? '\n' : ''}<console_output>\n${r.logs.join('\n')}\n</console_output>`
  const cap = maxTokens * 4
  let cut = false
  if (body.length > cap) {
    cut = true
    body = `${body.slice(0, cap / 2)}\n[... ${body.length - cap} characters omitted; full output in ${spill}: read it with file() or reprocess it in exec ...]\n${body.slice(-cap / 2)}`
  }
  const head = `Script ${r.error ? 'failed' : 'completed'} in ${secs.toFixed(1)}s`
  return { cut, text: [head, body, r.error && `Script error: ${r.error}`].filter(Boolean).join('\n') }
}

// One long-lived REPL child per session (repl.js). Its stdout is read by a loop started in the first exec's hook;
// every exec then reads its own run's messages from the inbox and answers tool calls with its own $.
type Msg = any
type Daemon = { dir: string; alive: boolean; inbox: Map<number, Msg[]>; wake: Map<number, () => void> }
const detached = new Map<string, number>() // per agent: scripts running in the background
const finished = new Map<string, string[]>() // per agent: output of detached scripts nobody has polled yet
const notices = new Map<string, string>() // one-line warnings shown with the next result, e.g. that the REPL restarted and lost its variables
const daemons = new Map<string, Daemon>() // one REPL per agent: the main loop's globals are not a subagent's, and a long run in one does not queue the other
let seq = 0
let mainBusy = false // whether the main loop is mid-turn (turn.start .. turn.complete)

// Takes every finished background result for an agent, once.
function drain(key: string): string[] {
  const got = finished.get(key) ?? []
  finished.set(key, [])
  return got
}

function trackLog(e: any): Call[] | undefined {
  const id = e.tool_use_id
  if (typeof id !== 'string') return undefined
  const log: Call[] = []
  logs.set(id, log)
  if (logs.size > LOG_KEEP) logs.delete(logs.keys().next().value as string)
  return log
}

async function ensureDaemon($: any, key: string): Promise<Daemon> {
  const live = daemons.get(key)
  if (live?.alive) return live
  if (live) notices.set(key, 'Note: the REPL restarted, so variables and functions from earlier scripts are gone.')
  const dir = (await $.process.run(['mktemp', '-d'])).stdout.trim()
  const d: Daemon = { dir, alive: true, inbox: new Map(), wake: new Map() }
  const push = (run: number, m: Msg) => {
    const q = d.inbox.get(run) ?? []
    q.push(m)
    d.inbox.set(run, q)
    d.wake.get(run)?.()
  }
  const stream = $.process.spawn({ argv: ['node', '--permission', `--allow-fs-read=${dir}`, `${$.plugin.root}/repl.js`, dir] })
  void (async () => {
    let buf = ''
    try {
      for await (const p of stream as AsyncIterable<any>) {
        if (!('stream' in p) || p.stream !== 'stdout') continue
        const lines = (buf + p.text).split('\n')
        buf = lines.pop() ?? ''
        for (const l of lines.filter(Boolean)) { try { const m = JSON.parse(l); push(m.run, m) } catch {} }
      }
    } catch {}
    d.alive = false
    await $.process.run(['rm', '-rf', dir]).catch(() => {}) // its own mktemp folder, never a pattern sweep
    for (const run of [...d.wake.keys()]) push(run, { t: 'dead' })
  })()
  daemons.set(key, d)
  return d
}

// A hook's own waiting counts against its 10 s budget; time inside a $ call does not. So every wait keeps one $ call in flight.
async function nextMsg($: any, d: Daemon, run: number): Promise<Msg> {
  for (;;) {
    const q = d.inbox.get(run)
    if (q?.length) return q.shift()
    if (!d.alive) return { t: 'dead' }
    const woke = new Promise<boolean>((res) => { d.wake.set(run, () => { d.wake.delete(run); res(true) }) })
    const woken = await Promise.race([woke, $.process.run(['sleep', '2']).then(() => false, () => false)])
    if (woken) return d.inbox.get(run)!.shift()
    d.wake.delete(run)
  }
}

// A big tool result reaches a script as Claude Code's "<persisted-output>" wrapper (a 2 KB preview and the path of the full text).
// Passing that on would hand the model a silently cut-off file, so the host reads the full text back (up to the 4 MiB a read allows).
// "unknown tool: X" names the nearest real tools, since a model's guess (tools.Glob, tools.mcp__x__y) is usually a near miss.
function closest(name: string, real: Map<string, string>): string {
  const w = name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean)
  const hits = [...real.keys()].map((k) => [w.filter((t) => k.toLowerCase().includes(t)).length, k] as const).filter(([s]) => s > 0).sort((a, b) => b[0] - a[0]).slice(0, 5).map(([, k]) => k)
  return hits.length ? `. Did you mean: ${hits.join(', ')}?` : '. Use searchTools("keyword") to find a tool by name.'
}

async function unwrap($: any, text: string): Promise<string> {
  if (!text.startsWith('<persisted-output>')) return text
  const path = /Full output saved to: (\S+)/.exec(text)?.[1]
  if (!path) return text
  try { return String(await $.fs.read(path)) } catch (err: any) { return `${text}\n[codemode: the full output could not be read back (${String(err?.message ?? err).slice(0, 120)}); only the 2 KB preview above is real]` }
}

// This build has no Glob or Grep tool (search is ripgrep behind Bash), but models habitually write tools.Glob / tools.Grep:
// both are offered here as shims over rg, run as an ordinary Bash call so hooks and permissions still apply.
const sq = (s: unknown) => "'" + String(s).replace(/'/g, "'\\''") + "'"
const SHIM_SCHEMAS: Record<string, { description: string; inputSchema: object }> = {
  Glob: { description: 'Find files by glob pattern (any depth, newest first). Input: { pattern, path? }. Returns the paths, one per line.', inputSchema: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] } },
  Grep: { description: 'Search file contents with ripgrep. Input: { pattern, path?, glob?, output_mode? ("files_with_matches" default | "content" | "count"), "-i"?, "-n"?, "-A"?, "-B"?, "-C"?, head_limit?, multiline? }. Returns text.', inputSchema: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' }, glob: { type: 'string' }, output_mode: { type: 'string' }, head_limit: { type: 'number' } }, required: ['pattern'] } },
}
function shimCommand(kind: string, i: any): string {
  const path = sq(i.path ?? '.')
  if (kind === 'Glob') return `rg --files --hidden -g '!.git' -g ${sq(i.pattern)} --sortr modified -- ${path} 2>&1; true`
  const mode = i.output_mode ?? 'files_with_matches'
  const f = ['--hidden', "-g '!.git'"]
  if (mode === 'files_with_matches') f.push('-l')
  else if (mode === 'count') f.push('-c')
  else { f.push('--no-heading'); if (i['-n'] !== false) f.push('-n') }
  if (i['-i']) f.push('-i')
  if (i.multiline) f.push('-U', '--multiline-dotall')
  for (const k of ['-A', '-B', '-C']) if (mode === 'content' && typeof i[k] === 'number') f.push(`${k} ${i[k]}`)
  if (i.glob) f.push('-g', sq(i.glob))
  if (i.type) f.push('-t', sq(i.type))
  const head = typeof i.head_limit === 'number' && i.head_limit > 0 ? ` | head -n ${Math.floor(i.head_limit)}` : ''
  return `rg ${f.join(' ')} -e ${sq(i.pattern)} -- ${path} 2>&1${head}; true`
}

// A failed tool's text reaches the script whole up to this many characters; beyond that the middle is cut, head and tail kept.
const ERROR_MAX = 8000
function capError(s: string): string {
  if (s.length <= ERROR_MAX) return s
  const half = ERROR_MAX / 2
  return s.slice(0, half) + `\n[… ${s.length - ERROR_MAX} more characters …]\n` + s.slice(-half)
}

async function toolReply($: any, real: Map<string, string>, m: any, log?: Call[]): Promise<object> {
  const note = (tool: string, text: string, err: boolean) => {
    if (!log || tool === 'ToolSearch') return
    try { const c = describeCall(tool, m.input, text, err); if (c) { log.push(c); $.ui.invalidate('ui.render') } } catch {}
  }
  try {
    let tool = real.get(m.tool)
    if (!tool) throw new Error(`unknown tool: ${m.tool}${closest(m.tool, real)}`)
    let shim = ''
    if (tool.startsWith('shim:')) { shim = tool.slice(5); tool = shim }
    if (tool === 'Skill') throw new Error('a skill cannot be loaded from a script here (its instructions would not reach you): call the Skill tool directly')
    const r: any = shim ? await $.tool.call({ tool: 'Bash', command: shimCommand(shim, m.input ?? {}) } as any) : await $.tool.call({ ...m.input, tool } as any)
    if (r.deny !== undefined) throw new Error(String(r.deny))
    // A failed tool's text (a non-zero exit's output included) reaches the script whole, like a successful one's.
    if (r.isError) throw new Error(await unwrap($, String(r.text ?? 'tool failed')))
    // The Bash tool reports empty output as a sentence; to a script it is the empty string it really was.
    const raw = await unwrap($, String(r.text ?? ''))
    const body = tool === 'Bash' && raw === '(Bash completed with no output)' ? '' : raw
    note(tool, body, false)
    const ctx = Array.isArray(r.context) ? r.context.map((c: any) => (typeof c === 'string' ? c : c?.text ?? '')).filter(Boolean).join('\n') : ''
    return { text: body + (ctx ? '\n' + ctx : '') }
  } catch (err: any) { note((real.get(m.tool) ?? m.tool).replace(/^shim:/, ''), String(err?.message ?? err), true); return { error: capError(String(err?.message ?? err)) } }
}

async function finish($: any, done: any, t0: number, maxTokens: number, spill: string) {
  if (!done.error) {
    if (JSON.stringify(done.kv).length > STORE_MAX) done.error = 'store is over 1 MiB'
    else await $.state.set(STORE, done.kv)
  }
  const secs = ((await $.clock.now()) - t0) / 1000
  const f = format(done, secs, maxTokens, spill)
  if (f.cut) await $.fs.write(spill, [...done.out, ...done.logs].join('\n'))
  return { result: f.text } as any
}

async function setup($: any, e: any) {
  const { code, opts } = parse(e.code)
  const all = (await $.tool.list()).filter((t: any) => !isNested(t.name)).map(({ name, description, inputSchema }: any) => ({ name: ident(name), real: name, description, inputSchema }))
  for (const k of ['Glob', 'Grep']) if (!all.some((t: any) => t.name === k)) all.push({ name: k, real: `shim:${k}`, ...SHIM_SCHEMAS[k] })
  return {
    code,
    all,
    real: new Map<string, string>(all.map((t: any) => [t.name, t.real])),
    own: Math.min(typeof e.timeout === 'number' && e.timeout > 0 ? e.timeout : 30000, MAX_TIMEOUT_MS),
    timeout: opts.timeout_ms === undefined ? ASYNC_WALL_CAP_MS : Math.min(opts.timeout_ms, MAX_TIMEOUT_MS),
    maxTokens: opts.max_output_tokens ?? MAX_TOKENS,
    kv: (await $.state.get(STORE)).value ?? {},
  }
}

async function runExec($: any, e: any): Promise<any> {
  const r = await runExecInner($, e)
  const key = agentKey(e), note = notices.get(key)
  if (note && typeof r?.result === 'string') { notices.delete(key); r.result = `${note}\n${r.result}` }
  const bg = typeof r?.result === 'string' ? drain(key) : []
  if (bg.length) r.result = `${r.result}\n\n[Background scripts that finished meanwhile]\n${bg.join('\n\n')}`
  return r
}

async function runExecInner($: any, e: any): Promise<any> {
  const key = agentKey(e)
  if (/^\/\/ @cancel\b/.test(e.code ?? '')) {
    const d = daemons.get(agentKey(e))
    if (!d?.alive) return { result: 'Nothing to cancel: no REPL is running.' } as any
    // A fresh token each time: the daemon may only read its directory, so it cannot delete this file and
    // instead cancels whenever the token changes.
    await $.fs.write(`${d.dir}/cancel`, `${Date.now()}-${Math.random()}`)
    return { result: 'Cancel sent: the running script is aborted (its globals are kept, calls already started finish on their own).' } as any
  }
  if (typeof e.code !== 'string' || !e.code.trim()) return { deny: 'exec needs a non-empty "code" string.' }
  const t0 = await $.clock.now()
  let files: string[] = []
  try {
    const s = await setup($, e)
    let d: Daemon
    try { d = await ensureDaemon($, String(e.agentId ?? 'main')) } catch { return await runOnce($, e) }
    const run = ++seq
    const slim = s.all.map(({ name, description, inputSchema }: any) => ({ name, description, inputSchema }))
    files = [`${d.dir}/q${run}.json`]
    await $.fs.write(files[0], JSON.stringify({ run, code: s.code, kv: s.kv, all: slim, timeout_ms: s.timeout, own_ms: s.own, detach_ms: DETACH_MS }))
    const calls: Promise<void>[] = []
    let n = 0
    const log = trackLog(e)
    const pump = async (stopOnLate: boolean): Promise<any> => {
      for (;;) {
        const m = await nextMsg($, d, run)
        if (m.t === 'done' || m.t === 'dead' || (stopOnLate && m.t === 'late')) return m
        if (m.t !== 'call') continue
        const f = `${d.dir}/r${run}_${m.id}.json`
        files.push(f)
        calls.push((async () => {
          const reply = ++n > TOOL_CALL_CAP ? { error: `a script may make at most ${TOOL_CALL_CAP} tool calls` } : await toolReply($, s.real, m, log)
          await $.fs.write(f, JSON.stringify(reply))
        })())
      }
    }
    const spill = `${d.dir}/out${run}.txt`
    const conclude = async (done: any) => {
      await Promise.allSettled(calls)
      if (done.t === 'dead') return { result: 'Script failed: the REPL process ended while the script was running.' } as any
      return await finish($, done, t0, s.maxTokens, spill)
    }
    const first = await pump(true)
    if (first.t !== 'late') {
      if (first.t === 'dead' && n === 0) return await runOnce($, e) // daemon died before doing anything: run it one-shot
      return await conclude(first)
    }
    // Still running: detach. The script goes on; its result lands in a file.
    const out = `${d.dir}/result${run}.txt`
    detached.set(key, (detached.get(key) ?? 0) + 1)
    void pump(false).then(conclude).then(async (r: any) => { await $.fs.write(out, r.result); finished.set(key, [...(finished.get(key) ?? []), `Script #${run} finished (also in ${out}):\n${r.result}`]) }).catch(async (err: any) => { await $.fs.write(out, `Script failed: ${err?.message ?? err}`).catch(() => {}); finished.set(key, [...(finished.get(key) ?? []), `Script #${run} failed: ${err?.message ?? err}`]) }).finally(async () => { detached.set(key, (detached.get(key) ?? 1) - 1); files = []; })
    files = []
    return { result: `Script #${run} is still running after ${DETACH_MS / 1000}s and has been detached to the background (limit ${ASYNC_WALL_CAP_MS / 3600000} h). Its calls go on. The next script starts now and runs beside it; they share variables. When it ends, its output is written to ${out} and delivered to you on its own (with your next exec result, or as a new message once your turn ends): do not poll in a loop.` } as any
  } catch (err: any) {
    return { result: `Script failed: ${err?.message ?? err}` } as any
  } finally {
    if (files.length) await $.process.run(['rm', '-f', ...files]).catch(() => {})
  }
}

// The one-shot fallback: a fresh runner.js per script, no persistence.
async function runOnce($: any, e: any): Promise<any> {
  notices.set(agentKey(e), 'Note: the persistent REPL is unavailable, so this script ran on its own and its variables will not persist.')
  const t0 = await $.clock.now()
  const dir = (await $.process.run(['mktemp', '-d'])).stdout.trim()
  try {
    const s = await setup($, e)
    const stream = $.process.spawn({
      argv: ['node', '--permission', `--allow-fs-read=${dir}`, `${$.plugin.root}/runner.js`, dir],
      input: JSON.stringify({ code: s.code, kv: s.kv, all: s.all.map(({ name, description }: any) => ({ name, description })), timeout_ms: s.timeout }),
    })
    const calls: Promise<void>[] = []
    const log = trackLog(e)
    let done: any, buf = '', stderr = '', n = 0
    for await (const { stream: so, text } of stream as AsyncIterable<any>) {
      if (so === 'stderr') { stderr += text; continue }
      const lines = (buf + text).split('\n')
      buf = lines.pop() ?? ''
      for (const l of lines.filter(Boolean)) {
        const m = JSON.parse(l)
        if (m.t === 'done') done = m
        else calls.push((async () => {
          const reply = ++n > TOOL_CALL_CAP ? { error: `a script may make at most ${TOOL_CALL_CAP} tool calls` } : await toolReply($, s.real, m, log)
          await $.fs.write(`${dir}/r${m.id}.json`, JSON.stringify(reply))
        })())
      }
    }
    await Promise.allSettled(calls)
    if (!done) return { result: `Script failed: the runner exited without a result. ${stderr.slice(0, 500)}`.trim() } as any
    return await finish($, done, t0, s.maxTokens, `${dir}.txt`)
  } catch (err: any) {
    return { result: `Script failed: ${err?.message ?? err}` } as any
  } finally {
    await $.process.run(['rm', '-rf', dir]).catch(() => {})
  }
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    try {
      await $.tool.register({
        name: 'exec',
        description: DESCRIPTION,
        isDeferred: false, // always in front of the model, so the model always sees the exec tool
        inputSchema: { type: 'object', properties: { code: { type: 'string', description: 'JavaScript source: the body of an async function. Its final expression (or an explicit return) is the result.' }, timeout: { type: 'number', description: "Optional cap on the script's own running time, in ms. Time spent waiting on tool calls is not counted. Default 30000, max 600000." } }, required: ['code'] },
      })
      await $.tool.register({
        name: 'poll',
        description: `Block until a background script finishes and return its output (waits up to ${POLL_MAX_MS / 60000} min). Rarely needed: finished output is delivered to you automatically, with your next exec result or as a new message once your turn ends.`,
        inputSchema: { type: 'object', properties: {} },
        isDeferred: false,
      })
      // Wakes an idle main loop with finished background results, the way a background Bash task's notification does.
      // Mid-turn nothing is sent: the results ride the next exec result, or this timer once the turn ends.
      $.clock.every(1000, async () => {
        if (mainBusy || !(finished.get('main')?.length)) return
        const got = drain('main')
        const left = detached.get('main') ?? 0
        try {
          await $.prompt.submit({ text: ['Code mode: background script output.', ...got, left ? `${left} script(s) still running in the background.` : ''].filter(Boolean).join('\n\n') })
        } catch { finished.set('main', [...got, ...(finished.get('main') ?? [])]) } // not delivered: leave it for poll or the next exec
      })
      ready = true
    } catch {} // a failed registration must never break the session (and then nothing is hidden or denied)
    return next(e)
  })

  // Standing guidance, as a system-prompt section. Static text only, so the prompt cache holds.
  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    if (!FORCE || !ready) return r
    return { ...r, sections: [...r.sections, { id: 'codemode:guidance', text: GUIDANCE, scope: 'session' as const }] }
  })

  // The deferred-tools reminder must not list the code-mode-only tools: the model reaches them only through scripts.
  on('prompt.attachment', async ($, e: any, next) => {
    const r: any = await next(e)
    if (!FORCE || !ready || e.type !== 'deferred_tools_delta' || typeof r?.text !== 'string') return r
    return { ...r, text: r.text.split('\n').filter((l: string) => !HIDDEN.has(l.trim())).join('\n') }
  })

  // The code-mode-only tools leave the prompt's tool list (behind ToolSearch); only a script reaches them.
  on('tool.describe', async ($, e: any, next) => {
    const r = await next(e)
    return FORCE && ready && HIDDEN.has(e.tool) ? { ...r, isDeferred: true } : r
  })

  on('tool.call', async ($, e: any, next) => {
    // Only the model's own call is refused: a call a script raises through $.tool.call has this plugin as its origin.
    const name = e.tool ?? e.name ?? e.toolName
    if (FORCE && ready && next.origin.plugin === 'engine' && name && (HIDDEN.has(name) || (name === 'Read' && !isVisualRead(e)))) return { deny: `${name} is a code-mode-only tool: call it from a script passed to ${EXEC}, e.g. await tools.${ident(name)}({...}).${name === 'Read' ? ' (Only image and PDF files may be Read directly.)' : ''}` } as any
    return next(e)
  })

  on('tool.call', { tool: POLL as any }, async ($, e: any, next) => {
    const key = agentKey(e)
    const t0 = await $.clock.now()
    while (!(finished.get(key)?.length) && (detached.get(key) ?? 0) > 0 && (await $.clock.now()) - t0 < POLL_MAX_MS) await $.process.run(['sleep', '1']) // a $ call in flight keeps the hook inside its budget
    const got = finished.get(key) ?? []
    finished.set(key, [])
    const left = detached.get(key) ?? 0
    const lines = [...got, left ? `${left} script(s) still running in the background.` : '']
    return { result: lines.filter(Boolean).join('\n') || '(no pending events)' } as any
  })

  // Track whether the main loop is mid-turn; at a turn's end, hand over any background output that finished meanwhile.
  on('turn.start', async ($, e: any, next) => {
    if (e.agentId === undefined) mainBusy = true
    return next(e)
  })
  on('turn.complete', async ($, e: any, next) => {
    const r = await next(e)
    if (e.agentId === undefined) {
      mainBusy = false
    }
    return r
  })

  on('tool.call', { tool: EXEC as any }, async ($, e: any, next) => {
    return await runExec($, e)
  })

  // What the transcript draws for an exec call (display only: the stored call and the model's result are untouched).
  // Collapsed: a grey count line, no script. Expanded (ctrl+o): the inner calls, each as Name(detail) with its result line.
  const failure = (output: unknown) => {
    const o: any = output
    const t = typeof o === 'string' ? o : String(o?.result ?? o?.text ?? JSON.stringify(o ?? ''))
    return /^(Note: [^\n]*\n)?Script failed\b/.test(t) ? t.split('\n').filter((l) => /Script (failed|error)|Error/.test(l)).slice(0, 3).join('\n') : ''
  }
  on('ui.render', { component: 'ToolUse', props: { tool: EXEC } } as any, async ($, e: any, next) => {
    if (!FORCE || !ready) return next(e as never)
    try {
      const { Box, Text, Button } = $.ui.resolve(e as never) as any
      const p = e.props
      const calls = logs.get(p.tool_use_id) ?? []
      const sum = summarise(calls)
      const head = sum ? (p.isRunning ? sum + '…' : sum) : p.isRunning ? 'Running script…' : 'Ran script'
      const words = head.split(/(\+\d+|\d+)/).filter(Boolean).map((s) => (/^\+\d+$/.test(s) ? Text({ color: 'green', children: s }) : /^\d+$/.test(s) ? Text({ bold: true, children: s }) : Text({ dimColor: true, children: s })))
      const shown = p.isExpanded || opened.has(p.tool_use_id)
      const id = p.tool_use_id
      const rows: any[] = [Button({ key: `codemode-${id}`, label: head, plain: true, children: words, onPress: () => { if (!opened.delete(id)) opened.add(id); $.ui.invalidate('ui.render') } } as any)]
      if (shown) {
        for (const c of calls) {
          rows.push(Text({ children: ['● ', Text({ bold: true, children: c.label }), Text({ dimColor: true, children: `(${c.detail})` })] }))
          if (c.out) rows.push(Text({ dimColor: !c.err, color: c.err ? 'red' : undefined, children: c.out.split('\n').map((l, i) => (i ? '     ' : '  ⎿  ') + l).join('\n') }))
        }
      }
      const bad = !p.isRunning && !p.isExpanded ? failure(p.output) : ''
      if (bad) rows.push(Text({ color: 'red', children: bad }))
      return Box({ flexDirection: 'column', marginY: 1, paddingLeft: 2, children: rows })
    } catch { return next(e as never) }
  })
  on('ui.render', { component: 'ToolResult', props: { tool: EXEC } } as any, async ($, e: any, next) => {
    if (!FORCE || !ready) return next(e as never)
    try {
      if (e.props.isExpanded) return next(e as never) // ctrl+o: the model's own result text, as it is
      return ($.ui.resolve(e as never) as any).Box({ display: 'none', children: [] })
    } catch { return next(e as never) }
  })
}