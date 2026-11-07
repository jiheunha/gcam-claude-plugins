import { expect, mock, test } from 'claude-code/testing'

// Collector output as the module reads it (see COLLECT in hooks/register.tsx), made up for the tests.
// A plain GCAM layout: no run records, no chain logs.
const NOW = Math.floor(Date.now() / 1000) // the band reads the clock for running lines
const YEARS = '0=1975 1=1990 2=2005 3=2010 4=2015 5=2021 6=2025 7=2030 8=2035 9=2040 10=2045 11=2050 '
// PROC|pid|cwd|seconds running|allowed CPUs|their count|CPUs in all|scenario|max-parallelism|config file|stop-year
// LOG|folder|mtime|period|last solved period|its iterations|unsolved periods|completed|period=year map
const PLAIN = [
  `NOW|${NOW}`,
  'PROC|4001|/work/gcam/exe_a|1500|12-23|12|24|REF_2050|12|configuration_REF_2050.xml|2050',
  'PROC|4002|/work/gcam/exe_b|600||24|24|NZE_2050|0|configuration_NZE_2050.xml|2050',
  `LOG|/work/gcam/exe_a|${NOW - 4}|10|9|1014|8 |0|${YEARS}`,
  `LOG|/work/gcam/exe_b|${NOW - 6}|7|6|2000||0|${YEARS}`,
  `LOG|/work/gcam/exe_c|${NOW - 916}|11|10|300||1|${YEARS}`,
  `LOG|/work/gcam/exe_d|${NOW - 2316}|8|7|450|6 |0|${YEARS}`,
].join('\n')

// The same, with run records and a chain (the optional extras).
const RECORDS = [
  `NOW|${NOW}`,
  'PROC|4001|/work/gcam/exe_rep_a|1500|12-23|12|24|REF_2050|12|configuration_REF_2050.xml|2050',
  `LOG|/work/gcam/exe_rep_a|${NOW - 4}|10|9|1014|8 |0|${YEARS}`,
  `RUN|261107_REF_2050_x|a|${NOW - 1500}||||12||REF_2050|`,
  `RUNLOG|261107_OLD_ok|11|11|455||1|${YEARS}`,
  `RUN|261107_OLD_ok|a|${NOW - 2000}|${NOW - 1000}|0|0|12||OLD_ok|VALID OLD_ok Iterations period 8: 473  core score = 1`,
  `RUNLOG|261107_OLD_bad|10|9|1014|9 |0|${YEARS}`,
  `RUN|261107_OLD_bad|b|${NOW - 2500}|${NOW - 1200}|143|2|12|0,0,1,0|OLD_bad|INVALID OLD_bad unknown=0 invalid=0 unsolved=1 ok=0 rc=143 Iterations period 8: 1014 `,
  'CHAIN|/work/logs/chain_set.status',
  'CS|2026-11-07 15:59:03 chain start',
  'CS|2026-11-07 15:59:03 launched 261107_REF_2050_x lane=a restart_from=none',
  'CD|D=261107',
  'CL|( launch REF_2050_x a ${D}_REF_2050_x ""; waitfor ${D}_REF_2050_x',
  'CL|    launch NEXT_one a ${D}_NEXT_one ""; waitfor ${D}_NEXT_one',
].join('\n')

const IDLE = `NOW|${NOW}\nLOG|/work/gcam/exe_a|${NOW - 90000}|11|10|300||1|${YEARS}`

const BAND = {
  plugin: 'gcam-progress',
  component: 'AbovePrompt',
  requestId: 'band',
  props: { hasSurvey: false, bodyColumns: 120, maxRows: 6, isFocused: false, scroll: { offset: 0, bodyRows: 6 }, view: {} },
} as const

const setup = async ($: any, on: any, ref: { raw: string }, flags: Record<string, unknown> = {}, argvs: string[][] = []) => {
  on('command.register', () => ({ value: { command: 'gcam-progress' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [] }))
  on('clock.every', () => ({ value: {} }))
  on('ui.render', () => ({ type: 'Text', text: 'engine' }) as never)
  on('store.get', (_: any, e: any) => ({ value: flags[e.key] }))
  on('store.set', (_: any, e: any) => { flags[e.key] = e.value; return { value: undefined } })
  on('store.delete', (_: any, e: any) => { delete flags[e.key]; return { value: undefined } })
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('process.run', (_: any, e: any) => {
    argvs.push(e.argv)
    return { value: { exitCode: 0, stdout: ref.raw, stderr: '' } }
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
}

const dumpOf = async (ui: any) => (await ui.findAll({ type: 'Text' })).map((x: any) => x.text).join('\n') as string

test('band, plain GCAM: running lines with year, last solved year:iterations, unsolved years; finished lines', async ($, on) => {
  await setup($, on, { raw: PLAIN })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const dump = await dumpOf(ui)
  // exe_a: CPU range (pinned to 12 of 24), scenario name, current year 2045, last solved 2040 with 1014 iterations
  expect(dump).toMatch(/12-23 REF_2050  2045  2040:1014  25m  running [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/)
  expect(dump).toContain('2035 UNSOLVED')
  // exe_b: max-parallelism 0 means all cores; no CPU pinning
  expect(dump).toMatch(/all NZE_2050  2030  2025:2000  10m  running/)
  // no folder names on running lines
  expect(dump).not.toContain('exe_a')
  expect(dump).not.toContain('exe_b')
  // finished: completed folder says just "finished", the stopped one says so and shows its unsolved year
  expect(dump).toMatch(/exe_c  2050  2045:300  finished/)
  expect(dump).not.toMatch(/exe_c[^\n]*finished [a-z]/)
  expect(dump).toMatch(/exe_d  2035  2030:450  finished stopped/)
  expect(dump).toContain('2025 UNSOLVED')
  expect(dump.indexOf('running')).toBeLessThan(dump.indexOf('finished'))
})

test('slash command prints the table with the folder, CPUs, period and status', async ($, on) => {
  await setup($, on, { raw: PLAIN })
  const res = await $.command.run({ command: 'gcam-progress', args: '' })
  expect(res.text).toContain('Exe folder')
  expect(res.text).toContain('ETA')
  expect(res.text).toMatch(/REF_2050\s+exe_a\s+12\s+12-23\s+Period 10: 2045\s+P9: 1014/)
  expect(res.text).toContain('2 GCAM run(s) active')
  expect(res.text).toContain('completed')
  expect(res.text).toContain('stopped, P6 2025 UNSOLVED')
})

test('a run that ends keeps its scenario name and elapsed time', async ($, on) => {
  const ref = { raw: PLAIN }
  await setup($, on, ref)
  await $.command.run({ command: 'gcam-progress', args: '' }) // sees REF_2050 running
  ref.raw = [`NOW|${NOW}`, `LOG|/work/gcam/exe_a|${NOW - 60}|11|10|300||1|${YEARS}`].join('\n')
  const res = await $.command.run({ command: 'gcam-progress', args: '' })
  expect(res.text).toMatch(/REF_2050\s+exe_a\s+12\s+Period 11: 2050\s+P10: 300\s+0:24:00\s+completed/)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await dumpOf(ui)).toMatch(/12 REF_2050  2050  2045:300  24m  finished/)
})

test('ETA comes from the periods the plugin watched finish, and is left out when there is no basis', async ($, on) => {
  const logAt = (p: number, ip: number) => `LOG|/work/gcam/exe_a|${NOW}|${p}|${ip}|100||0|${YEARS}`
  const proc = `PROC|4001|/work/gcam/exe_a|1000||24|24|REF|12|configuration_REF.xml|2050`
  const ref = { raw: `NOW|${NOW}\n${proc}\n${logAt(7, 6)}` }
  await setup($, on, ref)
  const first = await $.command.run({ command: 'gcam-progress', args: '' })
  expect(first.text).not.toMatch(/ETA\s+\S*~/) // one period seen, none finished: no basis
  // period 8 starts 240 s later, period 9 another 240 s later, then 100 s into period 10
  ref.raw = `NOW|${NOW + 240}\n${proc.replace('|1000|', '|1240|')}\n${logAt(8, 7)}`
  await $.command.run({ command: 'gcam-progress', args: '' })
  ref.raw = `NOW|${NOW + 480}\n${proc.replace('|1000|', '|1480|')}\n${logAt(9, 8)}`
  await $.command.run({ command: 'gcam-progress', args: '' })
  ref.raw = `NOW|${NOW + 580}\n${proc.replace('|1000|', '|1580|')}\n${logAt(9, 8)}`
  const res = await $.command.run({ command: 'gcam-progress', args: '' })
  // period 9 (2040): 140 s of a typical 240 s left, then 2045 and 2050 at 240 s each = 620 s = about 10 min
  expect(res.text).toMatch(/~10m/)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await dumpOf(ui)).toMatch(/ETA ~10m/)
  // stuck far beyond the typical period: no ETA
  ref.raw = `NOW|${NOW + 480 + 1000}\n${proc.replace('|1000|', '|2480|')}\n${logAt(9, 8)}`
  const stuck = await $.command.run({ command: 'gcam-progress', args: '' })
  expect(stuck.text).not.toContain('~')
})

test('band: nothing when no GCAM process runs and the last log is old', async ($, on) => {
  await setup($, on, { raw: IDLE })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /GCAM|REF|exe_a/ })).toBeUndefined()
})

test('options reach the collector as arguments', { options: { processName: 'my-gcam', exeFolders: '/data/exe_*:/more', runRecordsDir: '/rec', chainLogDir: '/chain' } }, async ($, on) => {
  const argvs: string[][] = []
  await setup($, on, { raw: IDLE }, {}, argvs)
  await $.command.run({ command: 'gcam-progress', args: '' })
  const last = argvs[argvs.length - 1]
  expect(last.slice(-4)).toEqual(['my-gcam', '/data/exe_*:/more', '/rec', '/chain'])
})

test('empty options: process name falls back to gcam.exe, the rest stays empty', { options: { processName: '', exeFolders: '', runRecordsDir: '', chainLogDir: '' } }, async ($, on) => {
  const argvs: string[][] = []
  await setup($, on, { raw: IDLE }, {}, argvs)
  await $.command.run({ command: 'gcam-progress', args: '' })
  expect(argvs[argvs.length - 1].slice(-4)).toEqual(['gcam.exe', '', '', ''])
})

test('run records: the record names the run, finished records give the verdict, the chain gives the queue', async ($, on) => {
  await setup($, on, { raw: RECORDS })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const dump = await dumpOf(ui)
  expect(dump).toMatch(/12-23 REF_2050_x  2045  2040:1014  25m/) // date prefix dropped
  expect(dump).toContain('finished VALID')
  expect(dump).toContain('finished INVALID (stopped)')
  expect(dump).toContain('GCAM queued: NEXT_one (a)')
  // the folder's last run is the one the record covers: it is not listed a second time
  expect((dump.match(/exe_rep_a/g) ?? []).length).toBe(0)
  expect((dump.match(/REF_2050_x/g) ?? []).length).toBe(1)
})

test('run records: INVALID shows its reason; unsolved-only drops the word', async ($, on) => {
  const mk = (run: string, rc: string, tm: string, un: string) => `RUNLOG|261107_${run}|9|||${un}|0|${YEARS}\nRUN|261107_${run}|a|${NOW - 3000}|${NOW - 2000}|${rc}|2|12|${tm}|${run}|INVALID ${run}\n`
  const raw = `NOW|${NOW}\n` + mk('A_only', '1', '0,0,2,0', '9 ') + mk('B_tag', '0', '1,0,0,1', '') + mk('C_to', '124', '0,0,0,0', '') + mk('D_crash', '139', '0,1,1,0', '10 ')
  await setup($, on, { raw })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const lines = await dumpOf(ui)
  expect(lines).toMatch(/A_only[^\n]*finished\s+2040 UNSOLVED/)
  expect(lines).not.toMatch(/A_only[^\n]*INVALID/)
  expect(lines).toContain('finished INVALID (bad tag)')
  expect(lines).toContain('finished INVALID (timeout)')
  expect(lines).toContain('finished INVALID (invalid year, crashed)')
})

test('band: a state written by the previous version (no unsolved, thr, nUnsolved, itersBand) still draws', async ($, on) => {
  const rows = [
    { kind: 'running', run: '261107_OLD_run', lane: 'a', period: 'Period 9: 2040', iters: 'P8: 5', elapsed: '0:10:00', status: 'running' },
    { kind: 'queued', run: '261107_QUEUED_run', lane: 'a' },
    { kind: 'valid', run: '261107_DONE_run', lane: 'b', status: 'VALID', elapsed: '0:05:00' },
  ]
  on('store.get', () => ({ value: undefined }))
  on('ui.render', () => ({ type: 'Text', text: 'engine' }) as never)
  on('state.get', () => ({ value: { value: { shape: 'snap-3', value: { at: '', note: '', rows } }, version: 1 } }))
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const dump = await dumpOf(ui)
  expect(dump).toContain('OLD_run  2040  P8:5')
  expect(dump).toContain('GCAM queued: QUEUED_run (a)')
})

test('off: hides the band, survives a new session, and only /gcam-progress on brings it back', async ($, on) => {
  const flags: Record<string, unknown> = {}
  await setup($, on, { raw: PLAIN }, flags)
  const off = await $.command.run({ command: 'gcam-progress', args: 'off' })
  expect(off.text).toContain('off')
  expect(flags.off).toBe(true)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /REF_2050/ })).toBeUndefined()
  await ui.unmount()

  // plain command: still prints the table, says off, and does not switch it on
  const plain = await $.command.run({ command: 'gcam-progress', args: '' })
  expect(plain.text).toContain('GCAM band: off')
  expect(plain.text).toContain('REF_2050')
  const ui2 = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui2.find({ type: 'Text', text: /REF_2050/ })).toBeUndefined()
  await ui2.unmount()

  const on1 = await $.command.run({ command: 'gcam-progress', args: 'on' })
  expect(on1.text).toContain('GCAM band: on')
  expect(flags.off).toBeUndefined()
  const ui3 = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui3.find({ type: 'Text', text: /REF_2050/ }))?.text).toBeTruthy()
  await ui3.unmount()
})

test('off flag set before the session starts keeps the band hidden', async ($, on) => {
  await setup($, on, { raw: PLAIN }, { off: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /REF_2050/ })).toBeUndefined()
  await ui.unmount()
})

test('band: running line has a spinner and minute-resolution time; finished lines have neither', async ($, on) => {
  const start = Math.floor(Date.now() / 1000) - 665
  const rows = [
    { kind: 'running', run: 'RUN_a', lane: 'a', period: 'Period 10: 2045', iters: 'P9: 5', elapsed: '0:00:01', startAt: start, status: 'running' },
    { kind: 'valid', run: 'DONE_b', lane: 'b', status: 'completed', elapsed: '0:05:00', endedAgo: 10 },
  ]
  on('store.get', () => ({ value: undefined }))
  on('ui.render', () => ({ type: 'Text', text: 'engine' }) as never)
  on('state.get', () => ({ value: { value: { shape: 'snap-3', value: { at: '', note: '', rows } }, version: 1 } }))
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const lines = (await dumpOf(ui)).split('\n')
  const run = lines.find(l => l.includes('RUN_a')) ?? ''
  expect(run).toMatch(/ 11m /)
  expect(run).toMatch(/running [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/)
  const done = lines.find(l => l.includes('DONE_b')) ?? ''
  expect(done).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/)
  expect(done).toContain('5m')
})

test('reload without session.start: the first band draw starts polling', async ($, on) => {
  let polls = 0
  on('ui.render', () => ({ type: 'Text', text: 'engine' }) as never)
  on('store.get', () => ({ value: undefined }))
  const clock = mock.clock(on)
  on('process.run', () => {
    polls += 1
    return { value: { exitCode: 0, stdout: PLAIN, stderr: '' } }
  })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await clock.advance(10)
  expect(polls).toBeGreaterThan(0)
  expect(await dumpOf(ui)).toContain('running')
})

test('band: at most 5 lines; running first, then the queue, then finished newest first; +N more on the last line', async ($, on) => {
  const row = (kind: string, run: string, extra: object = {}) => ({ kind, run, lane: 'a', period: 'Period 9: 2040', iters: 'P8: 5', elapsed: '0:05:00', status: kind === 'running' ? 'running' : 'completed', ...extra })
  const rows = [
    row('running', 'RUN_1'), row('running', 'RUN_2'), row('running', 'RUN_3'),
    row('queued', 'Q_1', { status: 'queued' }), row('queued', 'Q_2', { status: 'queued' }),
    ...[1, 2, 3, 4, 5].map(i => row('valid', `DONE_${i}`, { endedAgo: i * 60 })),
  ]
  on('store.get', () => ({ value: undefined }))
  on('ui.render', () => ({ type: 'Text', text: 'engine' }) as never)
  on('state.get', () => ({ value: { value: { shape: 'snap-3', value: { at: '', note: '', rows } }, version: 1 } }))
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const text = await dumpOf(ui)
  expect(text).toContain('RUN_3')
  expect(text).toContain('GCAM queued: Q_1 (a), Q_2 (a)')
  expect(text).toContain('DONE_1')
  expect(text).not.toContain('DONE_2')
  expect(text).not.toContain('DONE_3') // 3 running + queue + 1 finished = 5 lines; 4 finished dropped
  expect(text).toContain('+4 more (/gcam-progress)')
})

test('band: with more than 5 running runs only 5 show, the queue is dropped and counted', async ($, on) => {
  const rows = [
    ...[1, 2, 3, 4, 5, 6, 7].map(i => ({ kind: 'running', run: `RUN_${i}`, lane: `l${i}`, period: 'Period 9: 2040', iters: 'P8: 5', elapsed: '0:05:00', status: 'running' })),
    { kind: 'queued', run: 'Q_1', lane: 'a', status: 'queued' },
  ]
  on('store.get', () => ({ value: undefined }))
  on('ui.render', () => ({ type: 'Text', text: 'engine' }) as never)
  on('state.get', () => ({ value: { value: { shape: 'snap-3', value: { at: '', note: '', rows } }, version: 1 } }))
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const text = await dumpOf(ui)
  expect(text).toContain('RUN_5')
  expect(text).not.toContain('RUN_6')
  expect(text).not.toContain('GCAM queued')
  expect(text).toContain('+3 more (/gcam-progress)')
})

test('run records: a finished run shows the last solved period of its own log', async ($, on) => {
  await setup($, on, { raw: RECORDS })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const dump = await dumpOf(ui)
  // the verdict text only holds "Iterations period 8: 473"; the run's log copy ends at period 11 with 455 iterations
  expect(dump).toMatch(/OLD_ok  2050  2050:455  /)
  expect(dump).not.toContain('2035:473')
  expect(dump).toMatch(/OLD_bad  2045  2040:1014  /)
})
