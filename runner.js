// Code mode runner. stdin: {code, kv, all, timeout_ms}. stdout, JSON lines: {t:'call',id,tool,input}
// while the script runs, then {t:'done',out,logs,kv,error}. A call's reply arrives as <dir>/r<id>.json.
// Started with --permission, so the child can read only <dir> and cannot spawn processes (a guard against accidents,
// not a security boundary: node:vm is not one, and --permission does not restrict the network).
const fs = require('fs'), vm = require('vm')
const dir = process.argv[2]
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n')
const show = (x) => (typeof x === 'string' ? x : JSON.stringify(x, null, 2))
let input = ''
process.stdin.setEncoding('utf8').on('data', (d) => (input += d)).on('end', main)

let nid = 0
const pending = new Map()
const poll = setInterval(() => {
  for (const [id, p] of pending) {
    let r
    try { r = JSON.parse(fs.readFileSync(`${dir}/r${id}.json`, 'utf8')) } catch { continue }
    pending.delete(id)
    r.error ? p.rej(new Error(r.error)) : p.res(r.text)
  }
}, 8)

async function main() {
  const { code, kv, all, timeout_ms } = JSON.parse(input)
  const out = [], logs = [], EXIT = {}
  const done = (error) => {
    clearInterval(poll)
    send({ t: 'done', out, logs, kv, error: error && String(error.stack || error).split('\n').filter((l) => !/node:|runner\.js/.test(l)).slice(0, 4).join('\n') })
    setTimeout(() => process.exit(0), 20)
  }
  const timer = timeout_ms && setTimeout(() => done(new Error(`timed out after ${timeout_ms}ms`)), timeout_ms)
  const sandbox = {
    tools: new Proxy({}, { get: (_, tool) => (input = {}) => new Promise((res, rej) => { const id = ++nid; pending.set(id, { res, rej }); send({ t: 'call', id, tool: String(tool), input }) }) }),
    text: (x) => { out.push(show(x)) },
    console: { log: (...a) => { logs.push(a.map(show).join(' ')) } },
    exit: () => { throw EXIT },
    store: (k, v) => { if (v === undefined) delete kv[k]; else kv[k] = v },
    load: (k) => kv[k],
    ALL_TOOLS: all,
    searchTools: (q, { limit = 8 } = {}) => {
      const terms = q.toLowerCase().split(/\W+/).filter(Boolean)
      const score = (t) => terms.filter((w) => `${t.name} ${t.description}`.toLowerCase().includes(w)).length
      return all.map((t) => [score(t), t]).filter(([s]) => s).sort((a, b) => b[0] - a[0]).slice(0, limit).map(([, t]) => t)
    },
    Promise, JSON, Math, Date,
  }
  vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } })
  try {
    const ret = await new vm.Script(`(async () => {\n${code}\n})()`).runInContext(sandbox)
    if (ret !== undefined) out.push(show(ret))
  } catch (e) {
    if (e !== EXIT) return clearTimeout(timer), done(e)
  }
  clearTimeout(timer)
  done()
}
