# Performance checks

Run `bun scripts/benchmark-tui.ts` for a synthetic performance sample, or add
`--profile` to save a Bun CPU profile beside the generated benchmark under
`node_modules/.cache/moxen-benchmark/`. The runner bundles with production JSX
and React, matching the shipped app. Do not measure a long session using the
development JSX runtime (see [Contributing](contributing.md)).

The benchmark covers transcript projection at 100, 500 and 2,000 turns,
sidebar projection at 100, 500 and 2,000 delegated threads, and 20 React state
updates above 200 unchanged reply bodies. Each synthetic turn has two
messages, four completed tools and a checkpoint. The sidebar fixture puts
the parent after its children to exercise parent lookup. Renderer samples use
OpenTUI's headless renderer at 120 columns by 40 rows, with no provider,
network, real terminal or user data. It records wall time, process CPU time,
sampled RSS and frames during a one-second idle window. RSS is a process
sample, not a retained-heap or leak measurement.

## MXN-84: general pass, October 2026

The pass inspected transcript projection and rendering, sidebar grouping,
diff loading, animation clocks and visibility, background queries, server
subscription polling and provider-listener lifetimes. This extends the earlier
image-specific fix; that fix alone did not complete the performance pass.

Changes:

- Transcript projection indexes each turn's latest timestamp once. Checkpoint
  and plan placement previously scanned the entire transcript for every row.
  Turn duration finds minimum/maximum timestamps without sorting a second list.
- Unchanged reply bodies reuse parsed message/layout data and their React
  subtree. Edits, stream completion, theme changes and language changes still
  invalidate the appropriate cached work. Descendant context subscriptions
  continue to update image and modal state.
- Sidebar families use ID maps for parent lookups and append to per-family
  arrays instead of copying the growing array for each child. Settled-family
  lookup uses the same approach.
- The jump-to-bottom button observes rendered scroll/layout changes instead
  of waking an idle thread every 300 ms.
- Sidebar age refresh, pairing-code countdown, the shared native backdrop clock, skill-description
  scrolling and periodic context/usage/subagent/task-output reads stop their
  refresh timers when the terminal reports it is hidden. A data view can make
  one initial read on a visibility or key change; recurring reads wait until
  visible again. Provider work and server scheduling keep running.
- Client refreshes and server shell/thread polls permit at most one pending
  read per poller. Slow disks or paired-server links cannot accumulate reads
  on every timer deadline. Unsubscribing suppresses late snapshots/errors;
  a delayed provider-session lookup cannot attach a listener after cleanup,
  or attach several listeners while earlier lookups are pending.

Regression checks cover slow polls across multiple deadlines, unsubscribe
during a pending read/session lookup, hidden-terminal query and backdrop-clock
pause/resume, message edit/stream/theme invalidation, and the earlier off-screen
image resource lifecycle. Existing transcript/sidebar contract tests continue
to check ordering, waits, nesting, cancellation and plans.

## Measurement limits

The final isolated sample on macOS ARM64 with Bun 1.3.11 was:

| Workload | Before, median | After, median | After, p95 |
| --- | ---: | ---: | ---: |
| Project and group 100 turns | 0.73 ms | 0.38 ms | 0.50 ms |
| Project and group 500 turns | 5.87 ms | 1.43 ms | 1.78 ms |
| Project and group 2,000 turns | 70.91 ms | 5.12 ms | 6.35 ms |
| Build sidebar for 100 delegated threads | 0.23 ms | 0.19 ms | 0.26 ms |
| Build sidebar for 500 delegated threads | 1.63 ms | 0.97 ms | 1.00 ms |
| Build sidebar for 2,000 delegated threads | 14.59 ms | 3.79 ms | 4.31 ms |

For 20 state updates above 200 unchanged reply bodies, the final sample used
124 ms of process CPU in total; median wall time per update was 18.27 ms
(p95 22.34 ms). This did not establish a reliable wall-latency improvement
from caching: frame scheduling dominates this small renderer fixture. The
subsequent one-second idle sample produced zero native frames. Neither result
is a measurement of the entire app or of battery use.

The transcript and sidebar baselines were recorded before their respective
algorithm changes, with the same workload definitions. Warm-up runs precede the samples;
timings are observations, not CI thresholds. Renderer wall time includes its
frame scheduling, so CPU time is useful for work saved within a frame.

This pass is not a battery/power measurement or a production-session soak
test. It does not establish a maximum supported transcript size. Full snapshot
reads/serialization still scale with stored history when a thread changes;
transcript projection still visits history and sorts entries. Historical
markdown nodes and compressed image bytes remain retained while their thread
is open. Very deep delegation chains still require ancestor walks. Further
work here would involve incremental projections, transport or virtualization,
and should be measured separately.

Windows/Linux runtime behavior and CI must be verified on those platforms;
the changes use portable timers and collections and add no platform-specific
runtime path or shell dependency.
