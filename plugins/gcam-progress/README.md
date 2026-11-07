# gcam-progress

A Claude Code plugin that follows your running GCAM jobs in a band above the prompt. Each run shows its current period, how far it has solved, its elapsed time, a rough ETA and the years that did not solve. `/gcam-progress` prints the same information as a table.

```
12-23 REF_2050  2045  2040:1014  25m  ETA ~12m  running ⠋  2035 UNSOLVED
all NZE_2050  2030  2025:2000  10m  running ⠙
exe_c  2050  2045:300  3h12m  finished
```

## What the band shows

One line per run, left to right. Take the first line above:

| Part | Example | Meaning |
|---|---|---|
| CPUs or threads | `12-23`, `all` | The CPU range when the process is pinned to some CPUs only (with `taskset`, for example). Otherwise the configuration's `max-parallelism`, or `all` when it is 0 or less. |
| Run | `REF_2050` | The scenario name from the configuration (`scenarioName`). A leading `YYMMDD_` date is dropped. A finished run the plugin never saw running shows its folder name instead (`exe_c`). |
| Current year | `2045` | The model period being solved now, from the last `Period N: YYYY` line in `main_log.txt`. For a finished run, the last period it reached. |
| Last solved | `2040:1014` | The last period that finished solving, and how many solver iterations it took. A restarted run adds where it began solving, for example `2050:455 from 2045` (see below). |
| Elapsed | `25m` | Time since `gcam.exe` started; for a finished run, its total run time. |
| ETA | `ETA ~12m` | Rough time left (see [ETA](#eta)). Left out when there is no basis. |
| Status | `running ⠋` | `running` with a spinner, or `finished` for runs that ended in the last 60 minutes. `finished stopped` means the log has no completion line. `(log idle N min)` means a running run has not written to its log for 45 minutes or more. |
| Unsolved years | `2035 UNSOLVED` | In red: periods the log reports as `did not solve`. |

`from <year>` marks a restarted run. When GCAM restarts from saved periods, it restores them with 1 iteration each and then really solves the rest. The plugin shows the first period that took more than 1 iteration after such restored periods, so `2050:455 from 2045` means the run restored everything up to 2040, solved 2045 and 2050, and needed 455 iterations for 2050.

The band holds at most 6 lines: running runs first, then one `GCAM queued:` line (run records only), then finished runs, newest first. Finished runs stay for 60 minutes. If lines were left out, the last line ends with `+N more (/gcam-progress)`.

## The table

`/gcam-progress` prints every run of the last 12 hours:

```
Run       Exe folder  Threads  CPUs   Period           Iter (last solved)  Elapsed  ETA   Status
REF_2050  exe_a       12       12-23  Period 10: 2045  P9: 1014            0:25:00  ~12m  running, P8 2035 UNSOLVED
exe_c     exe_c                       Period 11: 2050  P10: 300            -              completed
```

| Column | Meaning |
|---|---|
| Run | Scenario name, as in the band, with its date prefix. |
| Exe folder | The folder `gcam.exe` runs in: its last path component, without a leading `exe_rep_`. A folder named `exe` shows with its parent (`gcam/exe`). |
| Threads | `max-parallelism` from the configuration (`all` for 0 or less). |
| CPUs | The CPU range when the process is pinned; empty otherwise. |
| Period | GCAM's period number and its year. |
| Iter (last solved) | `P<period>: <iterations>` of the last solved period, plus `from <year>` for a restarted run. |
| Elapsed | `h:mm:ss`. `-` when the start time is unknown. |
| ETA | As in the band. |
| Status | `running`, `completed`, `completed, unsolved`, `stopped`; with run records also `VALID`, `INVALID (<reason>)` and `queued`. Unsolved periods follow as `P<n> <year> UNSOLVED`. |

## Install

In Claude Code:

```
/plugin install gcam-progress --marketplace jiheunha/gcam-claude-plugins
```

or from a shell:

```
claude plugin install gcam-progress --marketplace jiheunha/gcam-claude-plugins
```

It needs Linux (or WSL), where `/proc` shows each process's folder and command line. macOS and Windows are not supported.

## Use

Nothing to set up for a plain GCAM install. The plugin shows every `gcam.exe` that runs under your user account on the machine where Claude Code runs, however it was started: from a terminal, tmux, `nohup`, a script or Claude. It does not see other users' runs or other machines. For each process it reads the configuration it was started with (`-C <file>`) for the scenario name and `max-parallelism`, and `logs/main_log.txt` in the folder the process runs in. It only reads; it never touches a GCAM process or its files.

- `/gcam-progress` prints the full table.
- `/gcam-progress off` hides the band, also in new sessions. `/gcam-progress on` brings it back.
- The band appears when a run is active or finished in the last hour, and goes away when there is nothing to show.

Running runs are always found. Finished runs are listed for the folders where the plugin saw `gcam.exe` running, the folders in `exeFolders`, and the runs in `runRecordsDir`. A finished run is shown under its scenario name if the plugin saw it running. A run that finished before the plugin started shows under its folder name. Status is `completed` when the log ends with `Model run completed.`, `completed, unsolved` when some period did not solve, and `stopped` when the process is gone and the log has no completion line, for example because the run was killed.

## Settings

Change these in `/config` (plugin options):

| Option | Default | What it does |
|---|---|---|
| `processName` | `gcam.exe` | Name of the GCAM executable to look for. |
| `exeFolders` | empty | Colon-separated folders or globs, for example `~/gcam/exe_*`. Their `logs/main_log.txt` is checked for finished runs even when the plugin never saw a run there. Folders where `gcam.exe` runs are always included. |
| `runRecordsDir` | empty | Optional run records written by a wrapper script. See [docs/run-records.md](docs/run-records.md). |
| `chainLogDir` | empty | Optional chain logs for the queued line. See the same page. |

## ETA

The ETA is the average of the last three periods the plugin watched finish in that run, applied to the periods still to come up to the configuration's `stop-year` (2100 if it has none), plus what is left of the current period. Periods are assumed to be 5 years apart beyond the ones the log has shown. The plugin has to see at least one period finish before it can estimate, so a run that has just started, or a plugin started in the middle of a period, shows no ETA yet.

Treat it as a rough guide. GCAM can spend up to its iteration limit (about 25,000 iterations) on a period that does not solve, which takes many times longer than a period that does. When the current period has already taken more than three times the typical one, the ETA is left out. With run records, a run whose scenario has earlier valid runs falls back to their typical wall time until its own periods give a better basis.

## Limits

- One band slot: other plugins that draw above the prompt, such as replay-theater, hide this band when they do not pass the call on to the plugins beneath them. If the band does not show, disable one of the two in `/plugin`.
- Years come from the `Period N: YYYY` lines in `main_log.txt`; only the last 8 MB of the log is read. If your log is elsewhere than `<run folder>/logs/main_log.txt`, the run shows without a period.
- The plugin polls every 12 seconds while something is running, and once a minute when idle.
- Runs of other users are not shown.

## License

MIT, see [LICENSE](LICENSE).
