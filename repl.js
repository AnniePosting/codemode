// Code mode REPL daemon, after earendil's pi.
// One long-lived node child per agent: scripts share one vm context (globals survive), each run gets its own
// bindings as function parameters so a detached script and the scripts after it run side by side.
// Host -> daemon: <dir>/q<run>.json {run, code, kv, all, timeout_ms, own_ms, detach_ms}; a tool call's reply is
// <dir>/r<run>_<id>.json; <dir>/cancel aborts every running script. Daemon -> host, JSON lines on stdout:
// {t:'call',run,id,tool,input}, {t:'late',run}, {t:'done',run,out,logs,kv,error}, {t:'state',runs:[...]}.
// Started with --permission, so the child can read only <dir> and cannot spawn processes or workers. That is a guard
// against accidents, not a security boundary: node:vm is not one, and --permission does not restrict the network.
const fs = require('fs'), vm = require('vm')
const dir = process.argv[2]
const SYNC_MS = 30000 // a script's synchronous stretch is stopped after this
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n')
const show = (x) => (typeof x === 'string' ? x : x === undefined ? '' : JSON.stringify(x, null, 2))
const EXIT = {}
// The last // @cancel token acted on (see the poll loop); one already present at start is not a new cancel.
let cancelSeen = ''
try { cancelSeen = fs.readFileSync(dir + '/cancel', 'utf8') } catch {}
const pending = new Map() // "<run>_<id>" -> {res, rej, run}
const seen = new Set()
const active = new Set()
const RING = { lines: [], dropped: 0 } // console.* output, shared by every script (a helper declared earlier logs here too)
const queue = []
let fg = null // the run that holds up the queue: it ends or runs for detach_ms, then the next one starts

const sandbox = { Promise, JSON, Math, Date, atob, btoa }
sandbox.globalThis = sandbox
sandbox.self = sandbox
vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } })

// ---- the shell: $`cmd`, $(cmd, timeoutMs), over the Bash tool ----
// Control characters (an ESC, a NUL-adjacent byte) make the Bash tool reject the whole command, so a value holding one is written as ANSI-C $'...' quoting.
const q = (s) => {
  s = String(s)
  if (/[\x00-\x08\x0b-\x1f\x7f]/.test(s)) return "$'" + s.replace(/[\\']/g, '\\$&').replace(/[\x00-\x1f\x7f]/g, (c) => '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0')) + "'"
  return "'" + s.replace(/'/g, "'\\''") + "'"
}
class ShellError extends Error {
  constructor(o) { super(o.error || 'exit ' + o.exitCode + (o.exitCode === 124 ? ' (timed out)' : '') + (o.stdout ? ': ' + o.stdout.slice(0, 300) : '')); this.name = 'ShellError'; this.stdout = o.stdout; this.stderr = o.stderr; this.exitCode = o.exitCode }
}
function shellOut(stdout, exitCode, error) {
  const o = { stdout, stderr: error || '', exitCode, truncated: false, whole: true, error }
  o.text = () => stdout; o.lines = () => stdout.split('\n').filter((l, i, a) => l !== '' || i < a.length - 1); o.json = () => JSON.parse(stdout)
  o.output = stdout + (error ? '\n[error] ' + error : '') + (exitCode ? '\n[exit ' + exitCode + ']' : '')
  return o
}
function makeShell(tools) {
  const dollar = (first, ...values) => {
    let cmd, tmo
    if (Array.isArray(first) && first.raw) {
      cmd = first.map((s, i) => s.replace(/\\(`|\$\{)/g, '$1') + (i < values.length ? (Array.isArray(values[i]) ? values[i].map(q).join(' ') : q(values[i])) : '')).join('')
    } else { cmd = String(first); tmo = values[0] }
    const opt = { nothrow: false, cwd: null, env: null, timeout: tmo }
    // A timeout really stops the command: the Bash tool only backgrounds a slow one, so wrap it in timeout(1) (exit 124 = timed out).
    const killer = (c) => opt.timeout ? 'timeout -k 2 ' + Math.max(1, Math.ceil(opt.timeout / 1000)) + 's bash -c ' + q(c) : c
    let started
    const run = () => (started ??= (async () => {
      let c = cmd
      // Exported in a subshell, so the variables reach every command of a compound line (`a && b`, pipes), not just
      // the first word, and do not leak into the Bash tool's persistent shell.
      if (opt.env) c = '(export ' + Object.entries(opt.env).map(([k, v]) => k + '=' + q(v)).join(' ') + '; ' + c + ')'
      if (opt.cwd) c = 'cd ' + q(opt.cwd) + ' && ' + c
      let out
      try {
        const input = { command: killer(c) }
        if (opt.timeout) input.timeout = opt.timeout + 5000
        out = shellOut(String(await tools.Bash(input)), 0)
      } catch (e) {
        const m = String(e && e.message || e)
        const x = /^Exit code (\d+)\n?([\s\S]*)$/.exec(m)
        out = x ? shellOut(x[2], Number(x[1])) : shellOut('', null, m)
      }
      if (!opt.nothrow && (out.exitCode !== 0)) throw new ShellError(out)
      return out
    })())
    const p = {
      then: (a, b) => run().then(a, b), catch: (b) => run().catch(b), finally: (f) => run().finally(f),
      nothrow() { opt.nothrow = true; return p }, throws(on) { opt.nothrow = !on; return p }, quiet() { return p },
      timeout(ms) { opt.timeout = ms; return p }, cwd(d) { opt.cwd = d; return p }, env(v) { opt.env = v; return p },
      text: () => run().then((o) => o.stdout), lines: () => run().then((o) => o.lines()), json: () => run().then((o) => o.json()),
    }
    return p
  }
  dollar.escape = q
  dollar.ShellError = ShellError
  return dollar
}

// ---- files: file(), write(), edit() over the Read, Write and Edit tools ----
function makeFiles(tools, $) {
  const file = (path) => ({
    name: path,
    text: () => $`cat -- ${path}`.text(),
    json: async () => JSON.parse(await $`cat -- ${path}`.text()),
    lines: async () => (await $`cat -- ${path}`.text()).split('\n'),
    exists: async () => (await $`test -e ${path}`.nothrow()).exitCode === 0,
    slice: async (offset = 1, limit = 2000) => (await $`sed -n ${offset + ',' + (offset + limit - 1) + 'p'} -- ${path}`.text()),
  })
  const write = async (path, content) => { await tools.Write({ file_path: path, content: String(content) }); return Buffer.byteLength(String(content)) }
  const edit = async (path, a, b, opts = {}) => {
    const pairs = Array.isArray(a) ? a : [[a, b]]
    const o = Array.isArray(a) ? b || {} : opts
    let replacements = 0
    try {
      await tools.Read({ file_path: path }) // the Edit tool wants the file read in this session first
      for (const [old, next] of pairs) {
        await tools.Edit({ file_path: path, old_string: old, new_string: next, replace_all: !!o.all })
        replacements += 1
      }
      return { ok: true, replacements }
    } catch (e) {
      if (o.soft) return { ok: false, replacements, error: String(e && e.message || e) }
      throw e
    }
  }
  return { file, write, edit }
}

function bindings(own) {
  // Functions a script declares outlive it (see withPersist) and keep closing over ITS $, tools, log and timers. When
  // such a helper is called from a later script, its calls, output and timers belong to the run that is live now.
  const live = () => (own.active ? own : fg && fg.active ? fg : [...active][0] || null)
  const run = new Proxy(own, { get: (o, k) => (k === 'active' ? o.active || live() !== null : (live() || o)[k]) })
  const timers = new Proxy({}, { get: (_, k) => { const t = (live() || own).timers; const v = t[k]; return typeof v === 'function' ? v.bind(t) : v } })
  const tools = new Proxy({}, { get: (_, tool) => (input = {}) => new Promise((res, rej) => {
    const r = live()
    if (!r) return rej(new Error('this script has already ended'))
    const id = ++r.nid
    r.inflight++
    pending.set(r.run + '_' + id, { res: (v) => { r.inflight--; res(v) }, rej: (e) => { r.inflight--; rej(e) }, run: r.run })
    send({ t: 'call', run: r.run, id, tool: String(tool), input })
  }) })
  const $ = makeShell(tools)
  const { file, write, edit } = makeFiles(tools, $)
  const setT = (fn, ms) => { const t = setTimeout(() => { timers.delete(t); if (run.active) fn() }, ms); timers.add(t); return t }
  const setI = (fn, ms) => { const t = setInterval(() => { if (run.active) fn(); else clearInterval(t) }, ms); timers.add(t); return t }
  const clr = (t) => { clearTimeout(t); clearInterval(t); timers.delete(t) }
  const push = (a) => { RING.lines.push(a.map(show).join(' ')); if (RING.lines.length > 500) { RING.lines.shift(); RING.dropped++ } }
  const con = { log: (...a) => push(a), info: (...a) => push(a), debug: (...a) => push(a), warn: (...a) => push(a), error: (...a) => push(a), tail: (n = 20) => RING.lines.slice(-n).join('\n'), buffer: () => RING.lines.join('\n'), dropped: () => RING.dropped }
  const describe = (name) => {
    const t = run.all.find((x) => x.name === name)
    return t ? { name: t.name, description: t.description, inputSchema: t.inputSchema || {} } : { error: 'no tool named ' + name }
  }
  return [
    tools,
    (x) => { run.out.push(show(x)) },
    con,
    () => { throw EXIT },
    (k, v) => { if (v === undefined) delete run.kv[k]; else run.kv[k] = v },
    (k) => run.kv[k],
    run.all.map(({ name, description }) => ({ name, description })),
    async (query, max = 8) => {
      const terms = String(query || '').toLowerCase().split(/\W+/).filter(Boolean)
      if (!terms.length) return { error: 'empty query' }
      const score = (t) => terms.filter((w) => (t.name + ' ' + t.description).toLowerCase().includes(w)).length
      return run.all.map((t) => [score(t), t]).filter(([s]) => s).sort((a, b) => b[0] - a[0]).slice(0, max).map(([, t]) => ({ name: t.name, about: t.description.split('\n')[0].slice(0, 200), input: JSON.stringify(t.inputSchema && t.inputSchema.properties ? Object.keys(t.inputSchema.properties) : []) }))
    },
    setT, clr, setI, clr, $, edit, write, file,
    (ms) => new Promise((r) => setT(r, ms)),
    (x, n = 200) => { const s = typeof x === 'object' && x && 'output' in x ? x.output : String(x ?? ''); return s.length > n ? s.slice(0, n) + '…[+' + (s.length - n) + ' chars]' : s },
    (...a) => { run.out.push(a.map(show).join(' ')) },
    () => [...active, ...queue.map((q2) => ({ run: q2.run, queued: true, code: q2.code, at: q2.at }))].map((r) => ({
      id: r.run, snippet: String(r.code || '').slice(0, 60), ageMs: Date.now() - (r.at || Date.now()),
      state: r.queued ? 'waiting' : r === fg ? 'running' : 'detached', settled: false, self: r === live(),
      abort: () => { if (r.cancel) r.cancel(); return true },
    })),
    describe,
  ]
}
const PARAMS = 'tools,text,console,exit,store,load,ALL_TOOLS,searchTools,setTimeout,clearTimeout,setInterval,clearInterval,$,edit,write,file,sleep,preview,log,running,describeTool'

// The script's value is its last expression's: if the last top-level line is a plain
// expression, return it. Falls back to the code as written when that does not compile.
function withLastValue(code) {
  const src = code.replace(/\s+$/, '')
  if (!src) return code
  // candidate split points, from the end: after a newline or a semicolon; the first one that compiles wins
  const cuts = []
  for (let i = src.length - 2; i >= 0 && cuts.length < 12; i--) if (src[i] === '\n' || src[i] === ';') cuts.push(i + 1)
  cuts.push(0)
  for (const c of cuts) {
    const head = src.slice(0, c), last = src.slice(c).trim().replace(/;$/, '')
    if (!last || /^(return|const|let|var|if|for|while|throw|try|switch|class|function|async function|else|break|continue|import|export)\b/.test(last) || /^[})\]./]|^\/\//.test(last)) continue
    try { new vm.Script('(async function(' + PARAMS + '){\n' + head + '\nreturn (' + last + ')\n})'); return head + '\nreturn (' + last + ')' } catch {}
  }
  return code
}

// Top-level const/let/var/function/class names of a script, so they can outlive it: the REPL keeps what a script
// declares for the next one, and here each script is the body of its own function. A light scanner (strings, template
// literals, comments, brace depth); a missed name just does not persist, a wrong one is caught when it is read back.
function topLevelNames(code) {
  const names = new Set()
  const ident = /^[A-Za-z_$][\w$]*$/
  const addPattern = (txt) => { for (const part of txt.split(',')) { let p = part.trim(); if (p.startsWith('...')) p = p.slice(3); if (p.includes(':')) p = p.split(':').pop(); p = p.split('=')[0].trim(); if (ident.test(p)) names.add(p) } }
  let depth = 0, paren = 0, i = 0, atStart = true
  const n = code.length
  while (i < n) {
    const c = code[i]
    if (c === '/' && code[i + 1] === '/') { while (i < n && code[i] !== '\n') i++; continue }
    if (c === '/' && code[i + 1] === '*') { const j = code.indexOf('*/', i + 2); i = j < 0 ? n : j + 2; continue }
    if (c === '"' || c === "'") { i++; while (i < n && code[i] !== c) { if (code[i] === '\\') i++; i++ } i++; atStart = false; continue }
    if (c === '`') { // template literal, ${ } nested
      i++
      const stack = [0]
      while (i < n && stack.length) {
        const d = code[i]
        if (d === '\\') { i += 2; continue }
        if (stack[stack.length - 1] === 0) { if (d === '`') { stack.pop(); i++; continue } if (d === '$' && code[i + 1] === '{') { stack.push(1); i += 2; continue } }
        else { if (d === '{') stack[stack.length - 1]++; else if (d === '}') { stack[stack.length - 1]--; if (stack[stack.length - 1] === 0) stack.pop() } else if (d === '`') { stack.push(0) } }
        i++
      }
      atStart = false
      continue
    }
    if (c === '{') depth++
    else if (c === '}') { depth--; atStart = true; i++; continue }
    else if (c === '(') paren++
    else if (c === ')') paren--
    else if (c === ';' || c === '\n') { atStart = true; i++; continue }
    if (atStart && depth === 0 && paren === 0 && /[A-Za-z]/.test(c)) {
      const m = /^(?:(?:const|let|var)\s+(?:([A-Za-z_$][\w$]*)|\{([^}]*)\}|\[([^\]]*)\])|(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)|class\s+([A-Za-z_$][\w$]*))/.exec(code.slice(i, i + 400))
      if (m) { if (m[1]) names.add(m[1]); if (m[2]) addPattern(m[2]); if (m[3]) addPattern(m[3]); if (m[4]) names.add(m[4]); if (m[5]) names.add(m[5]) }
    }
    if (!/\s/.test(c)) atStart = false
    i++
  }
  return [...names].filter((x) => !PARAMS.split(',').includes(x))
}
// A closure in the script's own scope sees its declarations (even later ones); fin() calls it when the script ends, however it ends.
function withPersist(code, id) {
  const names = topLevelNames(code)
  if (!names.length) return code
  const save = names.map((x) => 'try { globalThis.' + x + ' = ' + x + ' } catch (e) {}').join(' ')
  return 'globalThis.__saver' + id + ' = () => { ' + save + ' };\n' + code
}

function release(run) { if (fg === run) fg = null; startNext() }

function execute(q) {
  const run = { run: q.run, code: q.code, at: Date.now(), out: [], logs: [], kv: q.kv || {}, all: q.all || [], nid: 0, inflight: 0, own: 0, active: true, timers: new Set() }
  active.add(run)
  let wall, late, finished = false
  const fin = (error) => {
    if (finished) return
    finished = true
    clearTimeout(wall); clearTimeout(late)
    run.active = false
    try { const s = sandbox['__saver' + run.run]; if (s) s() } catch {} finally { delete sandbox['__saver' + run.run] }
    for (const t of run.timers) { clearTimeout(t); clearInterval(t) } // what a script started without awaiting stops with it
    run.timers.clear()
    active.delete(run)
    for (const [k, p] of pending) if (p.run === run.run) { pending.delete(k); p.rej(new Error('this script has already ended')) }
    send({ t: 'done', run: run.run, out: run.out, logs: run.logs, kv: run.kv, error: error && String(error.stack || error).split('\n').filter((l) => !/node:|repl\.js/.test(l)).slice(0, 14).join('\n').slice(0, 2000) })
    release(run)
  }
  fg = run
  if (q.detach_ms) late = setTimeout(() => { send({ t: 'late', run: run.run }); release(run) }, q.detach_ms)
  const stopped = new Promise((_, rej) => {
    wall = setTimeout(() => rej(new Error('timed out after ' + q.timeout_ms + ' ms')), q.timeout_ms)
    run.cancel = () => rej(new Error('cancelled (// @cancel, or abort() from running())'))
    run.overOwn = () => rej(new Error("the script's own running time passed " + q.own_ms + " ms (time inside the tool calls it awaits is not counted)"))
  })
  stopped.catch(() => {})
  run.ownLimit = q.own_ms
  run.last = Date.now()
  try {
    const fn = new vm.Script('(async function(' + PARAMS + '){\n' + withPersist(withLastValue(q.code), q.run) + '\n})').runInContext(sandbox)
    sandbox.__go = { fn, args: bindings(run) }
    let p
    try { p = new vm.Script('__go.fn.apply(undefined, __go.args)').runInContext(sandbox, { timeout: Math.min(q.timeout_ms, SYNC_MS) }) } finally { delete sandbox.__go }
    p.catch(() => {}) // a script that fails after it was stopped must not crash the daemon
    Promise.race([p, stopped]).then((ret) => { if (ret !== undefined) run.out.push(show(ret)); fin() }, (e) => fin(e === EXIT ? undefined : e))
  } catch (e) {
    fin(e === EXIT ? undefined : e)
  }
}

function startNext() { while (!fg && queue.length) execute(queue.shift()) }

const ppid0 = process.ppid
setInterval(() => {
  if (process.ppid !== ppid0) process.exit(0) // the session ended: do not outlive it
  const now = Date.now()
  for (const r of active) { // a script's own running time: the time it is not waiting on a tool call
    if (r.inflight === 0) { r.own += now - r.last; if (r.own > r.ownLimit && r.overOwn) { r.overOwn(); r.overOwn = null } }
    r.last = now
  }
  for (const [k, p] of pending) {
    let r
    try { r = JSON.parse(fs.readFileSync(dir + '/r' + k + '.json', 'utf8')) } catch { continue }
    pending.delete(k)
    r.error ? p.rej(new Error(r.error)) : p.res(r.text)
  }
  // The host writes a new token per // @cancel; --permission lets this child read the file but not delete it,
  // so a cancel is a token not seen before (a file left from an earlier daemon counts once, at start).
  let token = ''
  try { token = fs.readFileSync(dir + '/cancel', 'utf8') } catch {}
  if (token && token !== cancelSeen) { cancelSeen = token; for (const r of [...active]) r.cancel && r.cancel() }
  let names = []
  try { names = fs.readdirSync(dir) } catch {}
  for (const n of names) {
    if (!/^q\d+\.json$/.test(n) || seen.has(n)) continue
    let q
    try { q = JSON.parse(fs.readFileSync(dir + '/' + n, 'utf8')) } catch { continue } // half-written: try again next tick
    seen.add(n)
    q.at = Date.now()
    queue.push(q)
  }
  startNext()
}, 8)