import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { launch } from './harness.mjs'

/**
 * R6, R7, R8 and R11 — the numbers preflight §8.3 pre-registered and the plan
 * has owed since Phase 1.
 *
 * **They decide something that was chosen without them.** §2.4 picked one shared
 * REH over a server per project on architecture and licence, and said in as many
 * words that "R7 still decides". R7 is the marginal-cost test: if the second
 * project costs at least what the first did, four panes is four times one and the
 * shape of the product is wrong.
 *
 * ## What is measured, and why it is the process tree
 *
 * Resident memory **summed across every Chorus process** — the shell, each
 * workbench `WebContents`, the REH and its forked extension hosts. R11 says this
 * explicitly and says why: under `WebContentsView` each workbench is its own
 * process, so a heap sampled through CDP in any one renderer cannot see the
 * others, and the most likely real leak — a destroyed view whose process never
 * exits, or an extension host the REH never reaps — leaves the sampled heap flat
 * while the machine loses a gigabyte.
 *
 * So this walks the pid tree from the main process and sums RSS. It is the only
 * instrument that can see the thing the threshold is about.
 *
 * ## The three terms
 *
 *   M0  the app running, workbench built, **no project open**
 *   M1  one project
 *   M2  two projects, **on two distinct roots**
 *
 * Two surfaces on one root would share watchers and language servers and flatter
 * the result, which is why §4.1a requires distinct roots and why this creates
 * two temporary repositories rather than opening one twice.
 *
 * ## What it does not claim
 *
 * One machine, one run, one platform. These are *this machine's* numbers and the
 * inequality either holds here or it does not; a pass is not a guarantee about a
 * smaller laptop. Idle is 60 s because the thresholds say so — long enough for
 * the initial file scan to settle, and the reason a full run takes minutes.
 */

const IDLE_MS = Number(process.env['CHORUS_MEM_IDLE_MS'] ?? 60_000)
const CYCLES = Number(process.env['CHORUS_MEM_CYCLES'] ?? 10)

/** R6: one project, idle, summed across every process. */
const R6_CEILING_MB = 1_200
/** R8: idle CPU, two projects, mean across processes. */
const R8_CPU_PERCENT = 3
/** R11: return to within this of M1 after the open/close cycles. */
const R11_TOLERANCE = 0.15

/**
 * Every descendant of the main process, plus itself.
 *
 * Built from one `ps` listing rather than by asking each pid for its children:
 * the tree changes while it is being walked — an extension host forks, a helper
 * exits — and a walk that re-reads `ps` per level can count a process twice or
 * miss one entirely. One snapshot is internally consistent even if it is a
 * moment out of date.
 */
function tree(rootPid) {
  const listing = execFileSync('ps', ['-eo', 'pid=,ppid=,rss=,comm='], { encoding: 'utf8' })
  const rows = listing
    .split('\n')
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/))
    .filter((m) => m !== null)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), rssKb: Number(m[3]), comm: m[4] }))

  const byParent = new Map()
  for (const row of rows) {
    if (!byParent.has(row.ppid)) byParent.set(row.ppid, [])
    byParent.get(row.ppid).push(row)
  }
  const found = []
  const queue = [rows.find((r) => r.pid === rootPid)].filter(Boolean)
  const seen = new Set()
  while (queue.length > 0) {
    const row = queue.shift()
    if (seen.has(row.pid)) continue
    seen.add(row.pid)
    found.push(row)
    for (const child of byParent.get(row.pid) ?? []) queue.push(child)
  }
  return found
}

/** Total RSS in MB, and the inventory that produced it. */
function measure(rootPid) {
  const processes = tree(rootPid)
  const totalMb = processes.reduce((sum, p) => sum + p.rssKb, 0) / 1024
  const rehCount = processes.filter((p) => /server-main|\bnode$/.test(p.comm)).length
  return { totalMb, count: processes.length, rehCount, processes }
}

/**
 * Mean CPU across the tree over a window, from two `ps` cputime samples.
 *
 * `ps %cpu` on macOS is an average over the process's whole lifetime, not over
 * the last moment, so reading it once would report the startup burn as if it
 * were idle load. The difference of accumulated CPU time over a known wall-clock
 * window is the only honest reading here.
 */
function cpuSample(rootPid) {
  const listing = execFileSync('ps', ['-eo', 'pid=,ppid=,time='], { encoding: 'utf8' })
  const seconds = new Map()
  for (const line of listing.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+([\d:.]+)$/)
    if (m === null) continue
    const parts = m[3].split(':').map(Number)
    const secs =
      parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1]
    seconds.set(Number(m[1]), secs)
  }
  const pids = new Set(tree(rootPid).map((p) => p.pid))
  let total = 0
  for (const [pid, secs] of seconds) if (pids.has(pid)) total += secs
  return total
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** A throwaway repository, so the two roots are genuinely distinct. */
function scratchRepo(name) {
  const root = mkdtempSync(join(tmpdir(), `chorus-mem-${name}-`))
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'README.md'), `# ${name}\n`)
  writeFileSync(join(root, 'src', 'index.ts'), `export const ${name} = 1\n`)
  return root
}

async function main() {
  const rootA = scratchRepo('alpha')
  const rootB = scratchRepo('beta')

  /*
   * The seeded chooser is a **queue**, not a set: `CHORUS_WORKBENCH_E2E_ROOTS`
   * hands out one entry per `chooseWorkbenchProject()` call and then has nothing
   * left. Seeding `[rootA, rootB]` is enough to reach M2 and then the third open
   * of R11's first cycle hangs until the harness times out — which reads as the
   * app failing to open a project rather than as the gate running out of tape.
   *
   * So `rootB` is repeated once per cycle plus one. Every repeat is the *same*
   * directory on purpose: R11 is about opening and closing one project over and
   * over, where R7's distinct roots are about not sharing watchers.
   */
  const app = await launch({
    env: {
      CHORUS_WORKBENCH_E2E_ROOTS: [rootA, ...Array(CYCLES + 2).fill(rootB)].join(delimiter),
    },
  })

  const checks = []
  const check = (ok, label) => {
    checks.push({ ok, label })
    console.log(`  ${ok ? '✓' : '✗'} ${label}`)
  }

  /** Opens the next seeded root and returns its view id. */
  const openProject = async () => {
    const { chosen } = JSON.parse(
      await app.evaluate('window.chorus.chooseWorkbenchProject().then(JSON.stringify)')
    )
    const { viewId } = JSON.parse(
      await app.evaluate(
        `window.chorus.openWorkbench({ grant: ${JSON.stringify(chosen.grant)} }).then(JSON.stringify)`
      )
    )
    return viewId
  }

  const closeProject = async (viewId) =>
    app.evaluate(
      `window.chorus.closeWorkbench({ viewId: ${JSON.stringify(viewId)} }).then(() => 1)`
    )

  try {
    await app.until(`document.querySelector('#root') !== null`, { timeout: 120_000 })

    console.log(`\n  idling ${String(IDLE_MS / 1000)}s per measurement — this takes minutes\n`)

    await wait(IDLE_MS)
    const m0 = measure(app.pid)
    console.log(`  M0  no project      ${m0.totalMb.toFixed(1)} MB  ${String(m0.count)} processes`)

    const viewA = await openProject()
    await wait(IDLE_MS)
    const m1 = measure(app.pid)
    console.log(`  M1  one project     ${m1.totalMb.toFixed(1)} MB  ${String(m1.count)} processes`)

    const cpuBefore = cpuSample(app.pid)
    const viewB = await openProject()
    await wait(IDLE_MS)
    const m2 = measure(app.pid)
    const cpuAfter = cpuSample(app.pid)
    console.log(`  M2  two projects    ${m2.totalMb.toFixed(1)} MB  ${String(m2.count)} processes`)

    const first = m1.totalMb - m0.totalMb
    const second = m2.totalMb - m1.totalMb
    console.log(
      `\n  first project costs ${first.toFixed(1)} MB, second costs ${second.toFixed(1)} MB\n`
    )

    /*
     * R7, and the inequality is the whole test. A total would pass 1,000 + 900
     * and 200 + 1,700 alike, and the second is the failure the row exists to
     * catch — see §8.3's own correction.
     */
    check(
      second < first,
      `R7 — the second project costs less than the first (${second.toFixed(1)} MB < ${first.toFixed(1)} MB)`
    )
    check(
      m1.totalMb <= R6_CEILING_MB,
      `R6 — one project idles at or under ${String(R6_CEILING_MB)} MB (${m1.totalMb.toFixed(1)} MB)`
    )

    /*
     * R8. CPU time accumulated across the tree over the idle window, as a
     * percentage of one core, divided by the processes that could have burned it.
     */
    const cpuPercent = (((cpuAfter - cpuBefore) / (IDLE_MS / 1000)) * 100) / m2.count
    check(
      cpuPercent <= R8_CPU_PERCENT,
      `R8 — idle CPU with two projects is at or under ${String(R8_CPU_PERCENT)}% (${cpuPercent.toFixed(2)}%)`
    )

    // R11: open and close the second project repeatedly, then let it settle.
    console.log(`\n  R11 — ${String(CYCLES)} open/close cycles on the second project`)
    let cycling = viewB
    for (let pass = 0; pass < CYCLES; pass += 1) {
      await closeProject(cycling)
      await wait(500)
      cycling = await openProject()
      await wait(500)
    }
    await closeProject(cycling)
    await wait(IDLE_MS)
    const settled = measure(app.pid)
    console.log(
      `  after ${String(CYCLES)} cycles  ${settled.totalMb.toFixed(1)} MB  ${String(settled.count)} processes`
    )

    const drift = (settled.totalMb - m1.totalMb) / m1.totalMb
    check(
      drift <= R11_TOLERANCE,
      `R11 — memory returns within ${String(R11_TOLERANCE * 100)}% of M1 (${(drift * 100).toFixed(1)}%)`
    )
    /*
     * The second half of R11, and the one a memory figure alone would miss: a
     * view that is destroyed but whose process never exits shows up here as an
     * inventory that grew, even if RSS happened to settle.
     */
    check(
      settled.count <= m1.count,
      `R11 — the process inventory returns to its one-project shape (${String(settled.count)} vs ${String(m1.count)})`
    )
    /*
     * What survived, by name, and it is not decoration: "two processes leaked"
     * is a fact nobody can act on, and the two candidates R11 names — a
     * destroyed view whose process never exits, and an extension host the REH
     * never reaps — are fixed in completely different places.
     */
    if (settled.count > m1.count) {
      const tally = (m) => {
        const counts = new Map()
        for (const p of m.processes) counts.set(p.comm, (counts.get(p.comm) ?? 0) + 1)
        return counts
      }
      const before = tally(m1)
      const after = tally(settled)
      const grown = [...after.entries()]
        .map(([comm, n]) => ({ comm, delta: n - (before.get(comm) ?? 0) }))
        .filter((row) => row.delta > 0)
      for (const row of grown) {
        console.log(`      +${String(row.delta)}  ${row.comm}`)
      }
    }

    // R9 is recorded rather than gated — §8.3 chose observation deliberately.
    console.log(
      `\n  R9 (recorded, not a gate) — process count: M0 ${String(m0.count)}, M1 ${String(m1.count)}, M2 ${String(m2.count)}`
    )
    void viewA
  } finally {
    await app.quit()
  }

  const failed = checks.filter((c) => !c.ok).length
  console.log(failed === 0 ? `\nall ${String(checks.length)} passed` : `\n${String(failed)} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

await main()
