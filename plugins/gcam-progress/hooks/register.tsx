import { atom, read, update } from 'claude-code'
import type { Hook, Register } from 'claude-code'

import type { Row, Seen, SeenRun, Snapshot } from '../types'

// GCAM run progress band. Read-only: the collector below only runs pgrep, readlink, ps, stat,
// grep, tail, awk and date, on /proc and on plain-text files (the configuration a gcam.exe
// was started with, and logs/main_log.txt in its folder). It never touches a GCAM process or
// its files. Never pgrep -f / pkill -f.

const EVERY_MS = 12000
const WINDOW_S = 12 * 3600 // finished runs younger than this are listed in /gcam-progress
const MAX_FINISHED = 8
const RECENT_S = 60 * 60 // finished runs this young stay in the band
const BAND_LINES = 5 // the band never grows beyond this many lines
const STALE_S = 45 * 60 // running, but the log has not changed for this long
const STEP_YEARS = 5 // model period length assumed beyond the periods a log has shown
const DEFAULT_STOP_YEAR = 2100 // a configuration without a usable stop-year runs to here
const ETA_STUCK = 3 // no ETA once the current period has taken this many times the typical one
const MIN_PERIOD_S = 30 // shorter periods (calibration, restored by a restart) are not timed for the ETA
const MACHINE_PERIODS = 20 // period times kept across runs and sessions (plugin store) as the ETA's basis for a new run

const snap = atom(
  { plugin: 'gcam-progress', key: 'snap' } as const,
  { at: '', rows: [], note: 'No data yet.' } as Snapshot,
  { shape: 'snap-3' },
)

// The run last seen in each exe folder: its name for when it has finished, and the
// period timings behind the ETA. Session state, so a reload keeps it.
const seen = atom({ plugin: 'gcam-progress', key: 'seen' } as const, {} as Seen, { shape: 'seen-1' })

// Local redraw clock: written about four times per second while a run is live; the band reads it.
const tick = atom({ plugin: 'gcam-progress', key: 'tick' } as const, 0, { shape: 'tick-1' })

type Opts = { processName: string; exeFolders: string; runRecordsDir: string; chainLogDir: string }
let opts: Opts = { processName: 'gcam.exe', exeFolders: '', runRecordsDir: '', chainLogDir: '' }

// Arguments: $1 process name, $2 colon-separated exe folder globs, $3 run records dir, $4 chain log dir.
// No ${...} in here: this is a template literal. String.raw keeps backslashes.
const COLLECT = String.raw`
PN=$1; XF=$2; R=$3; L=$4
[ -n "$PN" ] || PN=gcam.exe
case "$R" in "~"*) R="$HOME$(printf %s "$R" | cut -c2-)";; esac
case "$L" in "~"*) L="$HOME$(printf %s "$L" | cut -c2-)";; esac
# Reads a main_log.txt on stdin: last period, last solved period with its iterations, unsolved periods,
# completed flag, period=year map.
summ() { grep -a -o -E '^Period [0-9]+: [0-9]{4}|Iterations period [0-9]+: [0-9]+|did not solve period [0-9]+|^Model run completed' | awk '/^Period /{n=$2; sub(/:/,"",n); y[n]=$3; lp=n} /^Iterations period /{ip=$3; sub(/:/,"",ip); iv=$4} /^did not solve/{u[$NF]=1} /^Model run completed/{dn=1} END{for(k in y)m=m k"="y[k]" "; for(k in u)ul=ul k" "; print lp"|"ip"|"iv"|"ul"|"dn+0"|"m}'; }
NOW=$(date +%s)
echo "NOW|$NOW"
NC=$(nproc --all 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null)
LIVE=""
for p in $(pgrep -u "$(id -un)" -x "$PN" 2>/dev/null); do
  c=$(readlink /proc/$p/cwd 2>/dev/null)
  [ -n "$c" ] || continue
  cfg=$(tr '\0' '\n' < /proc/$p/cmdline 2>/dev/null | awk 'BEGIN{c="configuration.xml"} t{c=$0;t=0;next} $0=="-C"||$0=="--configuration"{t=1;next} /^-C./{c=substr($0,3)} /^--configuration=/{c=substr($0,17)} END{print c}')
  case "$cfg" in /*) ;; *) cfg="$c/$cfg";; esac
  scn=$(grep -m1 -o 'name="scenarioName">[^<]*' "$cfg" 2>/dev/null | sed 's/.*>//')
  thr=$(grep -m1 -o 'name="max-parallelism">[-0-9]*' "$cfg" 2>/dev/null | sed 's/.*>//')
  stp=$(grep -m1 -o 'name="stop-year">[-0-9]*' "$cfg" 2>/dev/null | sed 's/.*>//')
  secs=$(ps -o etime= -p "$p" 2>/dev/null | tr -d ' ' | awk -F'[-:]' '{n=NF; s=$n+$(n-1)*60; if(n>=3)s+=$(n-2)*3600; if(n>=4)s+=$(n-3)*86400; print s}')
  al=$(awk '/Cpus_allowed_list/{print $2}' /proc/$p/status 2>/dev/null)
  cnt=$(echo "$al" | awk -F, '{n=0; for(i=1;i<=NF;i++){split($i,a,"-"); n+=(a[2]==""?1:a[2]-a[1]+1)} print n}')
  echo "PROC|$p|$c|$secs|$al|$cnt|$NC|$scn|$thr|$(basename "$cfg")|$stp"
  LIVE="$LIVE$c
"
done
ALL="$LIVE"
IFS=:
for pat in $XF; do
  case "$pat" in "~"*) pat="$HOME$(printf %s "$pat" | cut -c2-)";; esac
  for d in $pat; do [ -d "$d" ] && ALL="$ALL$d
"; done
done
unset IFS
printf '%s' "$ALL" | sort -u | while IFS= read -r d; do
  [ -n "$d" ] || continue
  m="$d/logs/main_log.txt"; [ -f "$m" ] || continue
  mt=$(stat -c %Y "$m" 2>/dev/null) || continue
  case "$LIVE" in *"$d"*) ;; *) [ $((NOW - mt)) -gt 86400 ] && continue;; esac
  echo "LOG|$d|$mt|$(tail -c 8000000 "$m" | summ)"
done
if [ -n "$R" ]; then
  for f in $(ls -t "$R"/*/timing.txt 2>/dev/null | head -40); do
    run=$(basename "$(dirname "$f")")
    s=$(grep -m1 '^START' "$f"); e=$(grep -m1 '^EXIT' "$f")
    lane=$(echo "$s" | sed -n 's/.*lane=\([^ ]*\).*/\1/p')
    [ -z "$lane" ] && continue
    scn=$(echo "$s" | sed -n 's/.*scenario=\([^ ]*\).*/\1/p')
    fol=$(printf '%s' "$ALL" | sort -u | awk -v l="$lane" '{n=split($0,a,"/"); b=a[n]; if(b==l||b=="exe_rep_" l){print; exit}}')
    thr=""
    [ -n "$fol" ] && thr=$(grep -m1 -o 'name="max-parallelism">[-0-9]*' "$fol/configuration_$scn.xml" 2>/dev/null | sed 's/.*>//')
    se=$(date -d "$(echo "$s" | awk '{print $2" "$3}')" +%s 2>/dev/null)
    ee=""; rc=""
    if [ -n "$e" ]; then rc=$(echo "$e" | awk '{print $2}'); ee=$(date -d "$(echo "$e" | awk '{print $3" "$4}')" +%s 2>/dev/null); fi
    dn=$(head -1 "$L/$run.done" 2>/dev/null)
    out=$(grep -m1 -E '^(VALID|INVALID)' "$L/$run.out" 2>/dev/null | cut -c1-300)
    if [ -n "$ee" ] && [ $((NOW - ee)) -lt 43200 ] && [ -f "$R/$run/main_log.txt" ]; then
      echo "RUNLOG|$run|$(tail -c 8000000 "$R/$run/main_log.txt" | summ)"
    fi
    tm=$(tail -1 "$f" | sed -n 's/^unknown_tags=\([0-9]*\) invalid_year=\([0-9]*\) unsolved=\([0-9]*\) ok=\([0-9]*\).*/\1,\2,\3,\4/p')
    echo "RUN|$run|$lane|$se|$ee|$rc|$dn|$thr|$tm|$scn|$out"
  done
fi
if [ -n "$L" ]; then
  C=$(ls -t "$L"/chain_*.status 2>/dev/null | head -1)
  if [ -n "$C" ]; then
    echo "CHAIN|$C"
    tail -40 "$C" | sed 's/^/CS|/'
    S=$(echo "$C" | sed 's/\.status$/.sh/')
    if [ -f "$S" ]; then
      echo "CD|$(grep -o 'D=[0-9]*' "$S" | head -1)"
      grep -E 'launch [A-Za-z0-9_]+ [a-z0-9]+ ' "$S" | sed 's/^/CL|/'
    fi
  fi
fi
`

type Proc = { pid: string; cwd: string; secs: number; cpu?: string; scn: string; thr: string; cfg: string; stop: string }
// What summ() in the collector reads out of one main_log.txt.
type Log = { mtime: number; period?: string; iterP?: string; iterN?: string; unsolved: string[]; done: boolean; years: Record<string, string> }
type Rec = {
  run: string
  lane: string
  scn: string
  start: number
  end?: number
  rc?: string
  done?: string
  thr?: string
  tm?: string // unknown_tags,invalid_year,unsolved,ok from the last line of timing.txt
  out: string
}

const num = (s: string | undefined) => (s && /^\d+$/.test(s) ? Number(s) : undefined)

// "9 10 " -> ['9', '10']
const numsOf = (s: string | undefined) =>
  (s ?? '').split(' ').filter(x => /^\d+$/.test(x)).sort((a, b) => Number(a) - Number(b))

const dur = (s: number) => {
  const t = Math.max(0, Math.round(s))
  const p = (n: number) => String(n).padStart(2, '0')
  return `${Math.floor(t / 3600)}:${p(Math.floor((t % 3600) / 60))}:${p(t % 60)}`
}

// The last path component, without the exe_rep_ prefix some setups give their folders.
const laneKey = (cwd: string) => (cwd.replace(/\/+$/, '').split('/').pop() ?? cwd).replace(/^exe_rep_/, '')

// What the table calls a run's folder; the default folder name 'exe' alone says nothing.
const folderLabel = (cwd: string) => {
  const key = laneKey(cwd)
  if (key !== 'exe') return key
  const parts = cwd.replace(/\/+$/, '').split('/')
  return parts.length > 1 ? `${parts[parts.length - 2]}/exe` : 'exe'
}

const periodText = (n: string | undefined, years: Record<string, string>) =>
  n === undefined || n === '' ? undefined : years[n] ? `Period ${n}: ${years[n]}` : `Period ${n}`

const unsolvedStrs = (ns: string[], years: Record<string, string>) => ns.map(n => (years[n] ? `P${n} ${years[n]}` : `P${n}`))

// "Iterations period 8: 1014" -> table "P8: 1014", band "2035:1014" (or "P8:1014" without a year); the last match wins.
const itersOf = (text: string | undefined, years: Record<string, string>) => {
  let last: RegExpMatchArray | undefined
  for (const m of (text ?? '').matchAll(/Iterations period (\d+): (\d+)/g)) last = m
  return last ? itersFmt(last[1], last[2], years) : undefined
}
const itersFmt = (p: string, n: string, years: Record<string, string>) => ({ iters: `P${p}: ${n}`, band: `${years[p] ?? `P${p}`}:${n}` })

// Why a run record called a run INVALID. text: band wording ('' when unsolved periods are the only reason).
const whyInvalid = (tm: string | undefined, rc: string | undefined) => {
  const m = /^(\d+),(\d+),(\d+),(\d+)$/.exec(tm ?? '')
  if (!m) return undefined
  const [ut, iy, un, ok] = m.slice(1).map(Number)
  const code = rc === undefined || rc === '' ? undefined : Number(rc)
  const why: string[] = []
  if (ut > 0) why.push('bad tag')
  if (iy > 0) why.push('invalid year')
  if (code === 124) why.push('timeout')
  else if (code === 143) why.push('stopped')
  else if (code !== undefined && code !== 0 && ![1, 2].includes(code)) why.push('crashed')
  else if (code !== undefined && ok === 0 && un === 0) why.push('crashed') // exit without success and no unsolved period to explain it
  return { why, unsolvedOnly: why.length === 0 && un > 0 }
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length === 0 ? undefined : s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}

// "~12m", "~1h05m"; under a minute "<1m".
const fmtEta = (s: number) => {
  const m = Math.round(s / 60)
  if (m < 1) return '<1m'
  return m >= 60 ? `~${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m` : `~${m}m`
}

// Time left. The typical period time is the mean of this run's last solved periods (3 at most),
// as the plugin saw them change; before it has any, the median of the periods it has timed in
// earlier runs on this machine (`machine`). Without either, undefined: no ETA. A period that has
// taken far longer than the typical one is probably not solving, and GCAM may spend its whole
// iteration limit there.
const etaOf = (s: SeenRun | undefined, now: number, curYear: number | undefined, stopRaw: string, machine: number[]) => {
  const durs = (s?.durs ?? []).slice(-3)
  const est = durs.length ? durs.reduce((a, b) => a + b, 0) / durs.length : median(machine)
  if (!s || est === undefined || s.cur === undefined || s.curAt === undefined || curYear === undefined || stopRaw === '') return undefined
  const inCur = now - s.curAt
  if (inCur > ETA_STUCK * est) return undefined
  const stop = Number(stopRaw) > 0 ? Number(stopRaw) : DEFAULT_STOP_YEAR
  const rest = Math.max(0, Math.ceil((stop - curYear) / STEP_YEARS))
  return Math.max(0, est - inCur) + rest * est
}

const build = (raw: string, prev: Seen, learned: Record<string, string>, machine: number[] = []): { snapshot: Snapshot; seen: Seen; timed: number[] } => {
  const timed: number[] = [] // period times measured on this poll, for the machine's record
  let now = Math.floor(Date.now() / 1000)
  const procs: Proc[] = []
  const logs = new Map<string, Log>()
  const runLogs = new Map<string, Log>() // a finished run's own copy of its main_log.txt (run records)
  const recs: Rec[] = []
  const status: string[] = []
  const planned: { run: string; lane: string }[] = []
  let day = ''

  for (const line of raw.split('\n')) {
    const f = line.split('|')
    if (f[0] === 'NOW') now = num(f[1]) ?? now
    else if (f[0] === 'PROC') {
      const cnt = num(f[5])
      const ncpu = num(f[6])
      procs.push({
        pid: f[1],
        cwd: f[2],
        secs: num(f[3]) ?? 0,
        cpu: f[4] && cnt !== undefined && ncpu !== undefined && cnt < ncpu ? f[4] : undefined, // pinned to some CPUs only
        scn: f[7] ?? '',
        thr: f[8] ?? '',
        cfg: f[9] ?? '',
        stop: f[10] ?? '',
      })
    } else if (f[0] === 'LOG' || f[0] === 'RUNLOG') {
      // LOG|folder|mtime|summary and RUNLOG|run|summary; summary = period|solved period|iterations|unsolved|completed|map
      const o = f[0] === 'LOG' ? 1 : 0
      const years: Record<string, string> = {}
      for (const m of (f[o + 7] ?? '').matchAll(/(\d+)=(\d{4})/g)) years[m[1]] = m[2]
      Object.assign(learned, years)
      const lg: Log = {
        mtime: f[0] === 'LOG' ? (num(f[2]) ?? 0) : 0,
        period: f[o + 2] || undefined,
        iterP: f[o + 3] || undefined,
        iterN: f[o + 4] || undefined,
        unsolved: numsOf(f[o + 5]),
        done: f[o + 6] === '1',
        years,
      }
      if (f[0] === 'LOG') logs.set(f[1], lg)
      else runLogs.set(f[1], lg)
    } else if (f[0] === 'RUN') {
      const start = num(f[3])
      if (start === undefined) continue
      recs.push({
        run: f[1],
        lane: f[2],
        start,
        end: num(f[4]),
        rc: f[5] || undefined,
        done: f[6] || undefined,
        thr: f[7] || undefined,
        tm: f[8] || undefined,
        scn: f[9] ?? '',
        out: f.slice(10).join('|'),
      })
    } else if (f[0] === 'CS') status.push(line.slice(3))
    else if (f[0] === 'CD') day = f[1].replace('D=', '')
    else if (f[0] === 'CL') {
      for (const m of line.matchAll(/launch\s+(\S+)\s+(\S+)\s+(\S+)/g)) {
        const run = m[3].replace('${D}', day).replace('$D', day)
        if (/^\d{6}_/.test(run)) planned.push({ run, lane: m[2] })
      }
    }
  }

  const nextSeen: Seen = {}
  for (const [k, v] of Object.entries(prev)) if (now - v.lastSeen <= WINDOW_S) nextSeen[k] = v

  // Typical wall time of this scenario's earlier valid runs (run records only): the ETA's second basis.
  const typical = new Map<string, number[]>()
  for (const r of recs) {
    if (r.scn && r.end !== undefined && /^VALID/.test(r.out)) typical.set(r.scn, [...(typical.get(r.scn) ?? []), r.end - r.start])
  }

  const running: Row[] = []
  const finished: { at: number; row: Row }[] = []
  const usedRec = new Set<Rec>()

  // Live runs: one row per gcam.exe process.
  for (const p of procs) {
    const lg = logs.get(p.cwd)
    const key = laneKey(p.cwd)
    const rec = recs.filter(r => r.lane === key && r.end === undefined && !usedRec.has(r)).sort((a, b) => b.start - a.start)[0]
    if (rec) usedRec.add(rec)
    const procStart = now - p.secs
    const startAt = rec ? rec.start : procStart
    const ownsLog = lg !== undefined && lg.mtime >= procStart - 30
    const years = { ...learned, ...(lg?.years ?? {}) }
    const run = rec?.run || p.scn || (p.cfg.replace(/^configuration_?/, '').replace(/\.xml$/, '') || folderLabel(p.cwd))
    const thrRaw = p.thr || rec?.thr || ''

    // The plugin's own timing of each period: the poll on which the current period changes.
    const old = prev[p.cwd]
    let s: SeenRun = old && Math.abs(old.procStart - procStart) <= 30 ? { ...old } : { run, startAt, procStart, thr: thrRaw, cpu: p.cpu, lastSeen: now }
    const isNew = !(old && Math.abs(old.procStart - procStart) <= 30)
    s = { ...s, run, startAt, thr: thrRaw, cpu: p.cpu, lastSeen: now }
    const period = ownsLog ? lg.period : undefined
    if (period !== undefined) {
      if (s.cur === undefined) {
        s.cur = period
        s.curAt = now
        s.curFull = !isNew // first seen in an earlier poll with no period yet: its start was watched
      } else if (s.cur !== period) {
        // Calibration periods and the periods a restart restores pass in seconds; they say nothing
        // about how long a real period takes, so only longer ones count.
        const d = s.curAt !== undefined ? now - s.curAt : 0
        if (s.curFull && d >= MIN_PERIOD_S) {
          s.durs = [...(s.durs ?? []), d].slice(-6)
          timed.push(d)
        }
        s.cur = period
        s.curAt = now
        s.curFull = true
      }
    }
    nextSeen[p.cwd] = s

    const curYear = period !== undefined && years[period] ? Number(years[period]) : undefined
    let etaSec = etaOf(s, now, curYear, p.stop, machine)
    if (etaSec === undefined && !(s.durs && s.durs.length) && rec?.scn) {
      const typ = median(typical.get(rec.scn) ?? [])
      if (typ !== undefined && now - rec.start <= 1.5 * typ) etaSec = Math.max(0, typ - (now - rec.start))
    }

    let label = 'running'
    if (ownsLog && now - lg.mtime > STALE_S) label += ` (log idle ${Math.round((now - lg.mtime) / 60)} min)`
    const it = ownsLog && lg.iterP && lg.iterN ? itersFmt(lg.iterP, lg.iterN, years) : undefined
    running.push({
      kind: 'running',
      run,
      lane: folderLabel(p.cwd),
      cpu: p.cpu,
      thr: thrRaw === '' ? '' : Number(thrRaw) <= 0 ? 'all' : thrRaw,
      unsolved: ownsLog ? unsolvedStrs(lg.unsolved, years) : [],
      nUnsolved: 0,
      period: ownsLog ? (periodText(lg.period, years) ?? '-') : 'starting',
      iters: it?.iters ?? '-',
      itersBand: it?.band,
      elapsed: dur(now - startAt),
      eta: etaSec === undefined ? undefined : fmtEta(etaSec),
      startAt,
      status: label,
    })
  }

  // Runs started by a wrapper that keeps run records (optional): starting, and finished ones.
  const newest = new Map<string, number>()
  for (const r of recs) newest.set(r.lane, Math.max(newest.get(r.lane) ?? 0, r.start))
  const laneBusy = new Set(procs.map(p => laneKey(p.cwd)))
  for (const r of recs) {
    if (usedRec.has(r)) continue
    const isNewest = newest.get(r.lane) === r.start
    let kind: Row['kind']
    let label: string
    let verdict2: string | undefined // band wording for a finished run; '' = nothing but the unsolved years
    if (r.end === undefined && !r.done && isNewest && !laneBusy.has(r.lane) && now - r.start < 150) {
      kind = 'starting'
      label = 'starting'
    } else {
      const verdict = /^(VALID|INVALID)/.exec(r.out)?.[1]
      const rc = r.rc ?? r.done
      if (verdict === 'VALID') {
        kind = 'valid'
        label = 'VALID'
      } else if (verdict === 'INVALID') {
        kind = 'invalid'
        label = rc && rc !== '0' ? `INVALID (rc ${rc})` : 'INVALID'
        const w = whyInvalid(r.tm, rc)
        if (w?.unsolvedOnly) {
          label = 'INVALID (unsolved only)'
          verdict2 = ''
        } else if (w && w.why.length) {
          label = `INVALID (${w.why.join(', ')})`
          verdict2 = label
        }
      } else if (rc === '0') {
        kind = 'valid'
        label = 'done (rc 0)'
      } else {
        kind = 'aborted'
        label = rc ? `aborted (rc ${rc})` : 'aborted'
      }
    }
    const isLive = kind === 'starting'
    if (!isLive && now - r.start > WINDOW_S) continue
    const end = r.end ?? (isLive ? now : undefined)
    // The run's own log copy gives the last solved period. The verdict text only holds the periods the
    // wrapper greps (and a restart prints 1 iteration for the periods it restores), so it is the fallback.
    const rl = runLogs.get(r.run)
    const years = { ...learned, ...(rl?.years ?? {}) }
    const it = isLive ? undefined : rl?.iterP && rl.iterN ? itersFmt(rl.iterP, rl.iterN, years) : itersOf(r.out, years)
    const row: Row = {
      kind,
      run: r.run,
      lane: r.lane,
      thr: !r.thr ? '' : Number(r.thr) <= 0 ? 'all' : r.thr,
      unsolved: unsolvedStrs(rl?.unsolved ?? [], years),
      nUnsolved: Number(/unsolved=(\d+)/.exec(r.out)?.[1] ?? 0),
      endedAgo: r.end !== undefined ? now - r.end : undefined,
      period: periodText(rl?.period, years) ?? (isLive ? 'starting' : '-'),
      iters: it?.iters ?? '-',
      itersBand: it?.band,
      elapsed: end !== undefined ? dur(end - r.start) : '-',
      startAt: r.start,
      verdict: verdict2,
      status: label,
    }
    if (isLive) running.push(row)
    else finished.push({ at: r.end ?? r.start, row })
  }

  // Finished runs that left no record: the last run in each exe folder with no live process,
  // named as the plugin saw it while it ran.
  const liveDirs = new Set(procs.map(p => p.cwd))
  for (const [dir, lg] of logs) {
    if (liveDirs.has(dir) || now - lg.mtime > WINDOW_S) continue
    const key = laneKey(dir)
    if (recs.some(r => r.lane === key && r.start <= lg.mtime + 5 && (r.end === undefined || r.end >= lg.mtime - 300))) continue
    const sr = prev[dir]
    const years = { ...learned, ...lg.years }
    const unsolved = unsolvedStrs(lg.unsolved, years)
    const it = lg.iterP && lg.iterN ? itersFmt(lg.iterP, lg.iterN, years) : undefined
    let kind: Row['kind'] = 'valid'
    let label = 'completed'
    if (!lg.done) {
      kind = 'aborted'
      label = 'stopped'
    } else if (unsolved.length) {
      kind = 'invalid'
      label = 'completed, unsolved'
    }
    finished.push({
      at: lg.mtime,
      row: {
        kind,
        run: sr?.run ?? folderLabel(dir),
        lane: folderLabel(dir),
        thr: !sr?.thr ? '' : Number(sr.thr) <= 0 ? 'all' : sr.thr,
        unsolved,
        nUnsolved: 0,
        endedAgo: now - lg.mtime,
        period: periodText(lg.period, years) ?? '-',
        iters: it?.iters ?? '-',
        itersBand: it?.band,
        elapsed: sr ? dur(lg.mtime - sr.startAt) : '-',
        startAt: sr?.startAt,
        verdict: kind === 'aborted' ? undefined : '', // the band shows just "finished" (and the unsolved years)
        status: label,
      },
    })
  }

  running.sort((a, b) => a.lane.localeCompare(b.lane))
  finished.sort((a, b) => b.at - a.at)

  // Queue from the newest chain script (run records and chain logs only): launches not yet in its status file.
  const queued: Row[] = []
  const launched = status.join('\n')
  const isChainOpen = !/chain done|STOP/.test(launched)
  if (isChainOpen && procs.length > 0) {
    for (const p of planned) {
      if (launched.includes(`launched ${p.run} `)) continue
      queued.push({ kind: 'queued', run: p.run, lane: p.lane, thr: '', unsolved: [], nUnsolved: 0, period: '-', iters: '-', elapsed: '-', status: 'queued' })
    }
  }

  const rows = [...running, ...queued, ...finished.slice(0, MAX_FINISHED).map(x => x.row)]
  const d = new Date(now * 1000)
  const p2 = (n: number) => String(n).padStart(2, '0')
  return {
    snapshot: {
      at: `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`,
      rows,
      note: procs.length === 0 ? 'No GCAM run is active.' : `${procs.length} GCAM run(s) active`,
    },
    seen: nextSeen,
    timed,
  }
}

const HEAD = ['Run', 'Exe folder', 'Threads', 'CPUs', 'Period', 'Iter (last solved)', 'Elapsed', 'ETA', 'Status']
// A row from older state or a half-written one never blanks the band.
const fix = (r: Partial<Row>): Row => ({
  kind: r.kind ?? 'aborted',
  run: r.run ?? '?',
  lane: r.lane ?? '?',
  thr: r.thr ?? '',
  cpu: r.cpu,
  unsolved: Array.isArray(r.unsolved) ? r.unsolved : [],
  nUnsolved: r.nUnsolved ?? 0,
  endedAgo: r.endedAgo,
  period: r.period ?? '-',
  iters: r.iters ?? '-',
  itersBand: r.itersBand,
  elapsed: r.elapsed ?? '-',
  eta: r.eta,
  startAt: r.startAt,
  verdict: r.verdict,
  status: r.status ?? '',
})

const readSnap = async ($: Dollar): Promise<Snapshot> => {
  const s = await read($, snap)
  return { at: s?.at ?? '', note: s?.note ?? '', rows: Array.isArray(s?.rows) ? s.rows.map(fix) : [] }
}

const isLiveKind = (r: Row) => r.kind === 'running' || r.kind === 'starting'
const isRecent = (r: Row) => !isLiveKind(r) && r.kind !== 'queued' && r.endedAgo !== undefined && r.endedAgo <= RECENT_S

const unsolvedParts = (r: Row) =>
  r.unsolved.length ? r.unsolved.map(u => `${u} UNSOLVED`) : r.nUnsolved > 0 ? [`${r.nUnsolved} UNSOLVED`] : []

const bandUnsolved = (r: Row) => unsolvedParts(r).map(u => u.replace(/^P\d+ (?=\d{4})/, ''))

const cells = (r: Row) => [r.run, r.lane, r.thr, r.cpu ?? '', r.period, r.iters, r.elapsed, r.eta ?? '', unsolvedParts(r).length ? `${r.status}, ${unsolvedParts(r).join(', ')}` : r.status]

const widths = (rows: Row[]) =>
  HEAD.map((h, i) => Math.max(h.length, ...rows.map(r => cells(r)[i].length)))

const asText = (s: Snapshot) => {
  const w = widths(s.rows)
  const line = (c: string[]) => c.map((x, i) => x.padEnd(w[i])).join('  ').trimEnd()
  return [
    `GCAM progress ${s.at}: ${s.note}`,
    line(HEAD),
    ...(s.rows.length ? s.rows.map(r => line(cells(r))) : ['(no runs in the last 12 h)']),
  ].join('\n')
}

const COLOR: Record<Row['kind'], string | undefined> = {
  running: 'cyan',
  starting: 'cyan',
  valid: 'green',
  invalid: 'red',
  aborted: 'red',
  queued: undefined,
}

type Dollar = Parameters<Hook<'session.start'>>[0]
let isOn = false
let quiet = 0 // consecutive polls with nothing running or queued
const learned: Record<string, string> = {} // period -> year, as the logs have shown it

// Fast redraw timer: runs only while a run is live and the band is on.
let ticker: { cancel: () => void } | undefined
function setTicking($: Dollar, want: boolean) {
  if (want && isOn && !ticker) {
    ticker = $.clock.every(250, () => {
      update($, tick, () => Date.now()).catch(err => {
        if (isGone(err)) stopAll()
      })
    })
  } else if (!(want && isOn) && ticker) {
    ticker.cancel()
    ticker = undefined
  }
}

// A callback of an instance whose environment was unloaded (reload, shutdown) must stop its timers.
const isGone = (err: unknown) => /unloaded/i.test(err instanceof Error ? err.message : String(err))

let poller: { cancel: () => void } | undefined
let started = false
function stopAll() {
  ticker?.cancel()
  ticker = undefined
  poller?.cancel()
  poller = undefined
  isOn = false
  started = false
}

async function refresh($: Dollar) {
  try {
    const res = await $.process.run(['bash', '-c', COLLECT, 'gcam-progress', opts.processName, opts.exeFolders, opts.runRecordsDir, opts.chainLogDir], { timeoutMs: 20000 })
    const before = (await read($, seen)) ?? {}
    const stored = await $.store.get('periodSecs')
    const machine = Array.isArray(stored) ? stored.filter((x): x is number => typeof x === 'number' && x >= MIN_PERIOD_S) : []
    const next = build(res.stdout, before, learned, machine)
    if (next.timed.length) await $.store.set('periodSecs', [...machine, ...next.timed].slice(-MACHINE_PERIODS))
    await update($, seen, () => next.seen)
    await update($, snap, () => next.snapshot)
    setTicking($, next.snapshot.rows.some(isLiveKind))
    return next.snapshot
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (isGone(err)) {
      stopAll()
      return undefined
    }
    // Keep the last rows on screen; only the note says the poll failed.
    await update($, snap, cur => ({ at: cur?.at ?? '', rows: cur?.rows ?? [], note: `refresh failed: ${msg.slice(0, 120)}` })).catch(() => undefined)
    return undefined
  }
}

// Start polling (the band shows whenever something runs or is queued).
// The off switch lives in the plugin's own store (a JSON file under ~/.claude), so it
// survives reloads and new sessions. While it is set nothing turns the band back on.
const isOffNow = async ($: Dollar) => (await $.store.get('off')) === true

async function clearBand($: Dollar) {
  isOn = false
  setTicking($, false)
  await update($, snap, () => ({ at: '', rows: [], note: 'off' }))
}

async function turnOn($: Dollar) {
  if (await isOffNow($)) return undefined
  isOn = true
  quiet = 0
  return refresh($)
}

// Scenario names often start with a YYMMDD_ date; the band drops it.
const short = (run: string) => run.replace(/^\d{6}_/, '')

const shortTime = (hms: string) => {
  if (!/^\d+:\d+:\d+$/.test(hms)) return ''
  const [h, m, s] = hms.split(':').map(Number)
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}m` : m > 0 ? `${m}m` : `${s}s`
}

const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const spinner = (t: number) => SPIN[Math.floor(t / 250) % SPIN.length]

// Running lines: minutes from the start time already collected; 11m, 1h05m above an hour.
const liveTime = (r: Row, nowMs: number) => {
  if (r.startAt === undefined) return shortTime(r.elapsed)
  const t = Math.max(0, Math.floor(nowMs / 1000 - r.startAt))
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const sec = t % 60 // under one minute only
  const p = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}h${p(m)}m` : m > 0 ? `${m}m` : `${sec}s`
}

const lineOf = (r: Row) => {
  const m = /^Period (\d+)(?:: (\d{4}))?/.exec(r.period)
  const per = m ? (m[2] ?? `P${m[1]}`) : r.period === '-' ? '' : r.period
  const it = r.iters === '-' ? '' : (r.itersBand ?? r.iters.replace(': ', ':'))

  return [[r.cpu ?? r.thr, short(r.run)].filter(Boolean).join(' '), per, it].filter(Boolean).join('  ')
}

// One poll every EVERY_MS. After about 2 idle minutes it slows to one poll a minute (it never
// stops, so a run started from anywhere shows up without a trigger).
function startLoop($: Dollar) {
  if (poller) return
  let n = 0
  poller = $.clock.every(EVERY_MS, async () => {
    try {
      if (!isOn) return
      n += 1
      if (quiet >= 10 && n % 5 !== 0) return
      if (await isOffNow($)) {
        await clearBand($)
        return
      }
      const now = await refresh($)
      const isBusy = now?.rows.some(r => isLiveKind(r) || r.kind === 'queued' || isRecent(r))
      quiet = isBusy ? 0 : quiet + 1
    } catch (err) {
      if (isGone(err)) stopAll()
    }
  })
}

// Runs on session.start and, because a reload does not always raise session.start, from the
// band's first draw in a fresh module instance. Idempotent per instance.
async function ensureStarted($: Dollar, isFirstPoll: boolean) {
  if (started) return
  started = true
  try {
    if (await isOffNow($)) {
      await clearBand($)
      startLoop($)
      return
    }
    isOn = true
    quiet = 0
    startLoop($)
    // The first poll runs in the background: the collector can take several seconds on a busy server.
    void refresh($)
  } catch (err) {
    started = false
    if (!isGone(err)) throw err
    if (isFirstPoll) stopAll()
  }
}

const str = (v: unknown, fallback: string) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : fallback)

export const register: Register = (on, options) => {
  opts = {
    processName: str(options?.processName, 'gcam.exe'),
    exeFolders: str(options?.exeFolders, ''),
    runRecordsDir: str(options?.runRecordsDir, ''),
    chainLogDir: str(options?.chainLogDir, ''),
  }

  on('session.end', ($, e, next) => {
    stopAll()
    return next(e)
  })

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'gcam-progress',
      description: 'Print the GCAM run table; a live band above the prompt follows the runs (on | off)',
      argumentHint: 'on | off',
    })
    await ensureStarted($, true)
    startLoop($)

    return next(e)
  })

  on('command.run', { command: 'gcam-progress' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'off') {
      await $.store.set('off', true)
      await clearBand($)

      return { text: 'GCAM band: off. It stays off (also in new sessions) until /gcam-progress on.' }
    }
    if (arg === 'on') await $.store.delete('off')

    const isOff = await isOffNow($)
    const s = (await turnOn($)) ?? (await readSnap($))
    const state = isOff ? 'GCAM band: off (turn it on with /gcam-progress on)' : 'GCAM band: on (hide it with /gcam-progress off)'

    return { text: `${state}\n${asText(s)}` }
  })

  // A Bash command that mentions gcam probably starts or stops a run: look right away
  // instead of waiting for the next poll.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (/gcam/i.test(e.command)) void turnOn($)

    return ran
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!started) $.clock.after(0, () => void ensureStarted($, false)) // a render never writes: start from a timer
    const s = await readSnap($)
    const nowMs = (await read($, tick)) || Date.now()
    const allLive = s.rows.filter(isLiveKind)
    const allDone = s.rows.filter(isRecent).sort((x, y) => (x.endedAgo ?? 0) - (y.endedAgo ?? 0))
    const allQueued = s.rows.filter(r => r.kind === 'queued')
    if ((await isOffNow($)) || e.props.hasSurvey || allLive.length + allDone.length + allQueued.length === 0) return next(e)

    // At most BAND_LINES lines. Running runs come first, then the one queued line, then finished runs, newest first.
    const live = allLive.slice(0, BAND_LINES)
    let left = BAND_LINES - live.length
    const queued = allQueued.length > 0 && left > 0 ? allQueued : []
    if (queued.length) left -= 1
    const done = allDone.slice(0, left)
    const dropped = allLive.length - live.length + (allQueued.length - queued.length) + (allDone.length - done.length)
    const lastLine = done.length ? 'done' : queued.length ? 'queued' : 'live'
    const more = dropped > 0 ? `  +${dropped} more (/gcam-progress)` : ''

    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        {live.map((r, i) => (
          <Text wrap="truncate-end">
            {[lineOf(r), liveTime(r, nowMs), r.eta ? `ETA ${r.eta}` : ''].filter(Boolean).join('  ')}  <Text color={COLOR[r.kind]}>{r.status} {spinner(nowMs)}</Text>
            {bandUnsolved(r).map(u => (
              <Text color="red">  {u}</Text>
            ))}
            {lastLine === 'live' && i === live.length - 1 && <Text dimColor>{more}</Text>}
          </Text>
        ))}
        {done.map((r, i) => (
          <Text wrap="truncate-end">
            {[lineOf(r), shortTime(r.elapsed)].filter(Boolean).join('  ')}  <Text color={COLOR[r.kind]}>finished{(r.verdict ?? r.status.split(' (')[0]) ? ' ' : ''}{r.verdict ?? r.status.split(' (')[0]}</Text>
            {bandUnsolved(r).map(u => (
              <Text color="red">  {u}</Text>
            ))}
            {lastLine === 'done' && i === done.length - 1 && <Text dimColor>{more}</Text>}
          </Text>
        ))}
        {queued.length > 0 && (
          <Text dimColor wrap="truncate-end">
            GCAM queued: {queued.map(r => `${short(r.run)} (${r.lane})`).join(', ')}
            {lastLine === 'queued' ? more : ''}
          </Text>
        )}
      </Box>
    )
  })
}
