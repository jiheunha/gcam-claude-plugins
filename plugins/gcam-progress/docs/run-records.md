# Run records and chain logs (optional)

Skip this page unless you start GCAM through a wrapper script that writes the files below. Without them the plugin works from the processes and logs alone. With them it also shows the wrapper's run names and verdicts (VALID or INVALID with the reason), keeps finished runs that left no log, and lists queued runs.

## `runRecordsDir`

One subfolder per run, named after the run:

```
<runRecordsDir>/<run>/timing.txt
<runRecordsDir>/<run>/main_log.txt     (optional copy of the run's log)
```

`timing.txt` holds:

- A line `START <date> <time> scenario=<scenario> lane=<lane> ...`, for example `START 2026-11-07 19:44:07 scenario=REF_2050 lane=a restart_from=none`. `lane` is the name of the exe folder, without a leading `exe_rep_`; it ties the record to the `gcam.exe` process running in that folder.
- A line `EXIT <rc> <date> <time>` once the run has ended.
- As its last line, optionally, `unknown_tags=N invalid_year=N unsolved=N ok=N`, which lets the band say why a run is INVALID.

The plugin reads the 40 newest records. When the exe folder also holds `configuration_<scenario>.xml`, its `max-parallelism` is shown as the thread count for finished runs.

## `chainLogDir`

The verdict files of the wrapper and the logs of a chain of runs:

- `<run>.done`: first line is the exit code.
- `<run>.out`: its first line starting with `VALID` or `INVALID` is the verdict, with `unsolved=N` and `Iterations period P: N` fields where the wrapper writes them.
- `chain_*.status`: one line per event, `... launched <run> lane=<lane> ...` and a final `chain done` (or `STOP`).
- `chain_*.sh`: the chain script. It sets `D=<YYMMDD>` and has lines `launch <name> <lane> ${D}_<name> ...`. A launch that has no `launched <run>` line yet in the status file is shown in the `GCAM queued:` line.

The newest chain is the one used, and queued runs show only while a `gcam.exe` process is running.
