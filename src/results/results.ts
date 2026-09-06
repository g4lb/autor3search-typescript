import { appendFile, readFile, stat } from 'node:fs/promises'
import type { DiscardReason, Status } from '../verdict/verdict.js'

/** Repo-root-relative default location of the log. */
export const RESULTS_PATH = 'results.tsv'

export const HEADER = 'commit\tscore\tbest_bench_delta\tp_min\tstatus\treason\tdescription'

const FIELD_COUNT = 7
/** Character (not byte) cap on `description`, ellipsis included. */
const DESCRIPTION_LIMIT = 256

const VALID_STATUSES: readonly Status[] = ['keep', 'discard', 'fail', 'crash']
const VALID_REASONS: readonly DiscardReason[] = [
  'no_significant_improvement',
  'improvement_below_min_effect',
  'significant_regression',
]

export interface Row {
  commit: string
  score: number
  bestBenchDelta: number
  pMin: number
  /**
   * Typed against verdict's own `Status` rather than a plain string: every
   * producer of a row already holds one of these four values, so a stray
   * status string would be a bug at the call site, not something this log
   * should quietly tolerate.
   */
  status: Status
  /**
   * A `DiscardReason` on a discard row; the empty string on every other
   * row (keep, fail, crash). Never `undefined` -- a field that sometimes
   * exists and sometimes doesn't cannot round-trip through a fixed
   * 7-column TSV, whose row shape does not vary with status.
   */
  reason: DiscardReason | ''
  description: string
}

export interface Summary {
  counts: Record<string, number>
  /** Product of every kept row's score; 1 (no-op) when there are none. */
  cumulativeSpeedup: number
  topWins: Row[]
}

/**
 * Tabs, CRs and LFs are the TSV's own field and row delimiters. Left
 * untouched, a single embedded newline in e.g. `description` would split
 * one experiment into two lines on disk -- and the second half, missing
 * its leading columns, would fail `loadRows`'s field-count check on every
 * future read. Flattening them to spaces before a value ever reaches disk
 * makes that failure mode structurally impossible rather than merely
 * unlikely, whatever the field.
 */
function sanitize(s: string): string {
  return s.replace(/[\t\r\n]/g, ' ')
}

/**
 * Truncates by Unicode code point, never by byte or by UTF-16 code unit.
 * `Array.from` iterates a string by code point, so a surrogate pair (an
 * astral character, e.g. an emoji) is kept or dropped whole. A byte-count
 * cut (e.g. slicing a UTF-8 `Buffer`) could stop mid-sequence and decode
 * back as a replacement character; a naive `.slice` on UTF-16 units could
 * split a surrogate pair into two lone, invalid halves. Either would let an
 * agent's pasted stack trace or diff -- pasted verbatim into `-desc` --
 * produce a row that doesn't even round-trip as valid text.
 */
function truncateDescription(s: string): string {
  const chars = Array.from(s)
  if (chars.length <= DESCRIPTION_LIMIT) return s
  return `${chars.slice(0, DESCRIPTION_LIMIT - 3).join('')}...`
}

function formatRow(r: Row): string {
  const fields = [
    sanitize(r.commit),
    // 4 decimals: score is a ratio hovering around 1.0, where a 0.01%
    // difference is noise; 4 places is enough to distinguish real
    // improvements without implying false precision.
    r.score.toFixed(4),
    // best_bench_delta is a percentage; 2 decimal places (0.01 pp) is
    // already finer than the run-to-run noise it's measuring.
    r.bestBenchDelta.toFixed(2),
    // p_min is a probability, not a percentage, and can be extremely
    // small (e.g. 1.08e-5). Formatting it to a fixed 2 decimals would
    // print "0.00" for every significant result, making them
    // indistinguishable from each other and from a genuine p=0. JS's
    // own number-to-string conversion is lossless (it prints the
    // shortest decimal that reads back to the exact same double), and
    // switches to exponential notation on its own for very small
    // magnitudes, so it is used as-is instead of a fixed decimal count.
    String(r.pMin),
    sanitize(r.status),
    sanitize(r.reason),
    truncateDescription(sanitize(r.description)),
  ]
  return fields.join('\t')
}

/**
 * Appends one row, writing the header first if the file is new or empty.
 * Not safe for concurrent writers -- callers are expected to hold the eval
 * lock across the whole experiment, so only one process ever appends at a
 * time.
 */
export async function appendRow(path: string, r: Row): Promise<void> {
  let needsHeader = true
  try {
    const info = await stat(path)
    needsHeader = info.size === 0
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    needsHeader = true
  }
  const prefix = needsHeader ? `${HEADER}\n` : ''
  await appendFile(path, `${prefix}${formatRow(r)}\n`, 'utf8')
}

/**
 * Parses one numeric column strictly. `Number('')` is `0` in JavaScript --
 * left unchecked, a torn write that leaves an empty field (still 7 fields
 * total, so the field-count check alone would never catch it) would
 * silently produce a legitimate-looking score of 0 rather than an obvious
 * parse failure. A blank `score` on a `keep` row is the worst case: it
 * collapses `summarize`'s cumulative-speedup PRODUCT for the ENTIRE log to
 * 0, with no visible anomaly. So blank is checked and rejected explicitly,
 * before ever calling `Number` on it; `Number.isFinite` then also catches
 * genuinely non-numeric text (which parses to `NaN`) and `Infinity`.
 */
function parseNumberField(path: string, lineNo: number, field: string, raw: string): number {
  if (raw.trim() === '') {
    throw new Error(`${path}:${lineNo}: ${field}: empty field, want a number`)
  }
  const n = Number(raw)
  if (!Number.isFinite(n)) {
    throw new Error(`${path}:${lineNo}: ${field}: invalid number "${raw}"`)
  }
  return n
}

/**
 * `status` must be one of the four values `Status` allows. An unrecognized
 * status has a milder blast radius than a bad number -- it simply never
 * matches the `'keep'` filter in `summarize`, so it can't poison the
 * cumulative-speedup product -- but it would still let `counts` silently
 * accumulate an unexpected key, which is the same "corrupted log
 * masquerading as valid" failure the field-count check exists to prevent.
 */
function parseStatus(path: string, lineNo: number, raw: string): Status {
  if (!VALID_STATUSES.includes(raw as Status)) {
    throw new Error(`${path}:${lineNo}: status: unknown status "${raw}"`)
  }
  return raw as Status
}

/** `reason` must be empty, or one of the three `DiscardReason` values. */
function parseReason(path: string, lineNo: number, raw: string): DiscardReason | '' {
  if (raw === '' || VALID_REASONS.includes(raw as DiscardReason)) {
    return raw as DiscardReason | ''
  }
  throw new Error(`${path}:${lineNo}: reason: unknown reason "${raw}"`)
}

/**
 * Loads every row. A missing file is an empty log, not an error -- this is
 * the state of a repository that has never run an experiment.
 *
 * Anything else is strict: a line that does not split into exactly 7
 * tab-separated fields, or whose numeric or enum fields don't parse,
 * fails the WHOLE load, naming the file and the 1-based line number.
 * Sanitizing on write (see `sanitize`) already makes a malformed row
 * nearly impossible to produce honestly, so encountering one is a real
 * signal -- a torn write, a hand edit -- not noise. Silently dropping the
 * bad row instead would let a corrupted log masquerade as a short one,
 * which is the worse failure for a file that is the sole record of an
 * unattended overnight run. The same reasoning extends past field count
 * to field *content*: a torn write is at least as likely to garble a
 * value as to drop a whole field, and a garbled numeric field that
 * parses "successfully" to 0 or NaN is a worse failure than a visible
 * parse error, since it distorts every summary silently.
 */
export async function loadRows(path: string): Promise<Row[]> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }

  const lines = text.split('\n')
  // A well-formed file ends with a trailing newline, which turns into one
  // trailing empty element after split; drop it rather than counting it as
  // a (blank, malformed) final line.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()

  const rows: Row[] = []
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1
    const rawLine = lines[i] ?? ''
    if (lineNo === 1 && rawLine === HEADER) continue
    const fields = rawLine.split('\t')
    if (fields.length !== FIELD_COUNT) {
      throw new Error(`${path}:${lineNo}: got ${fields.length} fields, want ${FIELD_COUNT}`)
    }
    const [commit, scoreStr, deltaStr, pMinStr, status, reason, description] = fields as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ]
    rows.push({
      commit,
      score: parseNumberField(path, lineNo, 'score', scoreStr),
      bestBenchDelta: parseNumberField(path, lineNo, 'best_bench_delta', deltaStr),
      pMin: parseNumberField(path, lineNo, 'p_min', pMinStr),
      status: parseStatus(path, lineNo, status),
      reason: parseReason(path, lineNo, reason),
      description,
    })
  }
  return rows
}

/** Number of "top wins" to report -- the most impactful kept experiments. */
const TOP_WINS = 3

/**
 * Counts per status, the cumulative speedup, and the biggest individual
 * wins. Never throws and never produces NaN, even for an empty log: an
 * empty log is a real, valid state (no experiments have run yet), not an
 * error, and a report reading it should say "1x, nothing tried yet"
 * rather than crash.
 */
export function summarize(rows: Row[]): Summary {
  const counts: Record<string, number> = {}
  for (const r of rows) {
    counts[r.status] = (counts[r.status] ?? 0) + 1
  }

  const kept = rows.filter((r) => r.status === 'keep')

  // The PRODUCT of every kept score, not the latest and not a mean. Each
  // KEEP advances the measurement baseline to the just-kept commit (see
  // baseline.measureCommit), so every subsequent score is only that
  // experiment's own incremental contribution on top of the last win, not
  // a re-measurement against the original baseline. Successive real
  // improvements compound the way successive percentage changes do, so
  // only their product reflects the true end-to-end speedup. `reduce`'s
  // seed of 1 is what makes an empty (or keep-less) log report "no
  // speedup yet" instead of dividing by, or starting from, zero.
  const cumulativeSpeedup = kept.reduce((acc, r) => acc * r.score, 1)

  const topWins = [...kept].sort((a, b) => a.score - b.score).slice(0, TOP_WINS)

  return { counts, cumulativeSpeedup, topWins }
}
