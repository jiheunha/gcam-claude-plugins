# gcam-progress

A Claude Code plugin that follows your running GCAM jobs in a band above the prompt. Each run shows its current period, how far it has solved, its elapsed time, a rough ETA and the years that did not solve. `/gcam-progress` prints the same information as a table.

```
12-23 REF_2050  2045  2040:1014  25m  ETA ~12m  running ⠋  2035 UNSOLVED
all NZE_2050  2030  2025:2000  10m  running ⠙
exe_c  2050  2045:300  3h12m  finished
```

Each line reads: CPU range (when the run is pinned to some CPUs) or thread count (`all` when `max-parallelism` is 0 or less), scenario name, the model year being solved, `last solved year:iterations`, elapsed time, ETA, status. Years that did not solve are added in red. A run restarted from earlier periods also shows where it began solving, for example `2050:455 from 2045`. Finished runs stay in the band for 60 minutes; the table lists the last 12 hours.

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

Nothing to set up for a plain GCAM install. The plugin looks for `gcam.exe` processes of your own user, reads the configuration each was started with (`-C <file>`) for the scenario name and `max-parallelism`, and reads `logs/main_log.txt` in the folder the process runs in. It only reads; it never touches a GCAM process or its files.

- `/gcam-progress` prints the full table.
- `/gcam-progress off` hides the band, also in new sessions. `/gcam-progress on` brings it back.
- The band appears when a run is active or finished in the last hour, and goes away when there is nothing to show. It shows at most 6 lines: running runs first, then one `GCAM queued:` line, then finished runs, newest first. If lines were left out, the last line ends with `+N more (/gcam-progress)`. The table always lists everything.

A finished run is shown under its scenario name if the plugin saw it running. A run that finished before the plugin started shows under its folder name. Status is `completed` when the log ends with `Model run completed.`, `completed, unsolved` when some period did not solve, and `stopped` when the process is gone and the log has no completion line, for example because the run was killed.

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
