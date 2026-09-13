# Analytics

The site sends GA4 events to `G-F9LCBV5XKM`. Analytics failures do not
interrupt package loads. Package names and versions come from explicitly
selected index entries; raw store paths and reverse-identified paths do
not produce named package events.

| Event | Meaning | Parameters |
| --- | --- | --- |
| `package_requested` | A selected package enters a boot or addition | `package_name`, `package_version`, `selection_method`, `operation` |
| `boot_started` | A boot is attempted, including isolation failures | `package_count` |
| `boot_ready` / `boot_failed` | The guest reaches its prompt, or boot throws | `duration_ms`, `package_count`, `boot_mode`, `stage` |
| `packages_add_started` | An addition to a running guest is attempted | `package_count` |
| `packages_add_ready` / `packages_add_failed` | The addition finishes or throws | `duration_ms`, `package_count`, `boot_mode`, `stage` |
| `cache_summary` | A boot or addition finishes | `operation`, `cache_hits`, `cache_misses`, `cache_bytes`, `fetched_bytes` |
| `range_resolved` | The range form finishes parsing and resolving | `outcome`, `duration_ms`, `package_count` on resolution |
| `grail_opened` | The generated Grail link is clicked | None |

Selection methods are `picker`, `range`, `url`, and `agent`. Operations
are `boot` and `add`. Boot mode is `snapshot`, `cold`, or `unknown` when
unavailable or adding to a running guest. Failure stages identify the
broad phase (`isolation`, `closure`, `download`, `guest`); parallel engine
startup failures can appear under `download`.

Package requests count attempts, including retries. Adding to a running
VM emits package events only for selected roots not already mounted.
Boot success describes the guest reaching its prompt, not whether each
selected package provides a working executable. A closed or hung tab may
send a start event without a completion event.

Cache counters cover completed byte reads through `fetchWithProgress`
for the guest, snapshot, and NARs. A miss means those bytes came through
`fetch`, which may itself use the browser's HTTP cache. Counters exclude
narinfo reads, the engine's HTTP cache, prefetch traffic, and failed
partial downloads. NAR integrity retries can contribute multiple reads.
The summary stops accepting reads when the operation ends, even if other
parallel requests are still completing.

# GA4 property setup

Under Admin > Custom definitions, create event-scoped dimensions for
`package_name`, `selection_method`, `operation`, `boot_mode`, `stage`,
and `outcome`. Create custom metrics for the numeric counts and byte
values; use milliseconds for `duration_ms` and standard units for the
others. Register `package_version` as a dimension only if version-level
reports are needed: many name/version combinations can cause GA4 to
group less common rows into `(other)`.

Use DebugView with debug mode enabled for a test session to verify live
delivery after deployment. Offline tests verify queued event contents and
cache accounting, not receipt by Google.

# Tradeoffs

Google receives package choices along with the analytics identifiers and
browser metadata collected by the tag. Analytics blockers and closed tabs
make counts incomplete.
The script and event requests add network traffic; cache summaries avoid
one analytics event per dependency. Custom dimensions may take 24–48 hours
to become available in reports.

References: [custom events](https://developers.google.com/analytics/devguides/collection/ga4/events),
[pageviews and history tracking](https://developers.google.com/analytics/devguides/collection/ga4/views),
[custom dimensions and metrics](https://support.google.com/analytics/answer/14240153).
