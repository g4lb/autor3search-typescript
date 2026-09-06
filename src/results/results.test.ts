import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { HEADER, RESULTS_PATH, appendRow, loadRows, summarize, type Row } from './results.js'

async function tmp(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'ars-results-'))
}

function row(overrides: Partial<Row> = {}): Row {
  return {
    commit: 'abc1234',
    score: 0.9231,
    bestBenchDelta: -12.5,
    pMin: 0.0031,
    status: 'keep',
    reason: '',
    description: 'a fine experiment',
    ...overrides,
  }
}

describe('RESULTS_PATH', () => {
  it('is results.tsv', () => {
    expect(RESULTS_PATH).toBe('results.tsv')
  })
})

describe('appendRow', () => {
  it('writes the header before the first row when the file does not yet exist', async () => {
    const dir = await tmp()
    const file = path.join(dir, RESULTS_PATH)
    await appendRow(file, row())
    const text = await readFile(file, 'utf8')
    const lines = text.split('\n').filter((l) => l.length > 0)
    expect(lines[0]).toBe(HEADER)
    expect(lines).toHaveLength(2)
  })

  it('does not duplicate the header on a second append', async () => {
    const dir = await tmp()
    const file = path.join(dir, RESULTS_PATH)
    await appendRow(file, row({ commit: 'aaa' }))
    await appendRow(file, row({ commit: 'bbb' }))
    const text = await readFile(file, 'utf8')
    const lines = text.split('\n').filter((l) => l.length > 0)
    expect(lines.filter((l) => l === HEADER)).toHaveLength(1)
    expect(lines).toHaveLength(3)
  })

  it('one appendRow call produces exactly one line', async () => {
    const dir = await tmp()
    const file = path.join(dir, RESULTS_PATH)
    await appendRow(file, row())
    const text = await readFile(file, 'utf8')
    expect(text.endsWith('\n')).toBe(true)
    expect(text.slice(0, -1).split('\n')).toHaveLength(2)
  })
})

describe('loadRows', () => {
  it('loads a missing file as an empty log rather than throwing', async () => {
    const dir = await tmp()
    const file = path.join(dir, RESULTS_PATH)
    await expect(loadRows(file)).resolves.toEqual([])
  })

  it('round-trips a keep row with an empty reason', async () => {
    const dir = await tmp()
    const file = path.join(dir, RESULTS_PATH)
    const r = row({ status: 'keep', reason: '' })
    await appendRow(file, r)
    const loaded = await loadRows(file)
    expect(loaded).toHaveLength(1)
    expect(loaded[0]).toEqual(r)
  })

  it('round-trips a discard row with a reason', async () => {
    const dir = await tmp()
    const file = path.join(dir, RESULTS_PATH)
    const r = row({
      commit: 'def5678',
      score: 1.02,
      bestBenchDelta: 3.25,
      pMin: 0.87,
      status: 'discard',
      reason: 'no_significant_improvement',
      description: 'no-op refactor',
    })
    await appendRow(file, r)
    const loaded = await loadRows(file)
    expect(loaded[0]).toEqual(r)
  })

  it('round-trips a tiny p-value without collapsing it to zero', async () => {
    const dir = await tmp()
    const file = path.join(dir, RESULTS_PATH)
    const r = row({ pMin: 1.08e-5 })
    await appendRow(file, r)
    const loaded = await loadRows(file)
    expect(loaded[0]?.pMin).not.toBe(0)
    expect(loaded[0]?.pMin).toBeCloseTo(1.08e-5, 12)
  })

  it('sanitizes tabs, carriage returns and newlines in commit and description so one experiment stays one row', async () => {
    const dir = await tmp()
    const file = path.join(dir, RESULTS_PATH)
    await appendRow(
      file,
      row({
        commit: 'abc\t123\rdef\n456',
        description: 'line one\nline two\twith tab\rcarriage',
      }),
    )
    const text = await readFile(file, 'utf8')
    const lines = text.split('\n').filter((l) => l.length > 0)
    // The header plus exactly one data line: no stray fields ever split
    // the row across lines.
    expect(lines).toHaveLength(2)
    const loaded = await loadRows(file)
    expect(loaded).toHaveLength(1)
    expect(loaded[0]?.commit).not.toMatch(/[\t\r\n]/)
    expect(loaded[0]?.description).not.toMatch(/[\t\r\n]/)
    expect(loaded[0]?.commit).toBe('abc 123 def 456')
    expect(loaded[0]?.description).toBe('line one line two with tab carriage')
  })

  it('sanitizes tabs and newlines even when they appear in status or reason', async () => {
    const dir = await tmp()
    const file = path.join(dir, RESULTS_PATH)
    await appendRow(
      file,
      row({
        status: 'ke\tep\n' as Row['status'],
        reason: 'weird\rreason' as Row['reason'],
      }),
    )
    const loaded = await loadRows(file)
    expect(loaded[0]?.status).not.toMatch(/[\t\r\n]/)
    expect(loaded[0]?.reason).not.toMatch(/[\t\r\n]/)
  })

  it('leaves a short description untouched', async () => {
    const dir = await tmp()
    const file = path.join(dir, RESULTS_PATH)
    const description = 'short'
    await appendRow(file, row({ description }))
    const loaded = await loadRows(file)
    expect(loaded[0]?.description).toBe(description)
  })

  it('truncates an over-long ASCII description at 256 characters, ellipsis included', async () => {
    const dir = await tmp()
    const file = path.join(dir, RESULTS_PATH)
    const description = 'x'.repeat(300)
    await appendRow(file, row({ description }))
    const loaded = await loadRows(file)
    const got = loaded[0]?.description ?? ''
    expect(got).toHaveLength(256)
    expect(got.endsWith('...')).toBe(true)
    expect(got.slice(0, 253)).toBe('x'.repeat(253))
  })

  it('truncates by character count, not bytes: a 2-byte-UTF-8 character sitting right at the cut is kept whole, not corrupted', async () => {
    // 'é' encodes as 2 bytes in UTF-8. Placed as the 253rd character (the
    // last one a 256-character-with-ellipsis result keeps), a BYTE-based
    // cut to 253 bytes would only have room for the character's first byte,
    // producing an invalid/incomplete UTF-8 sequence -- which Node decodes
    // back as U+FFFD (the replacement character). A correct, character-based
    // cut keeps the whole character and never produces U+FFFD.
    const dir = await tmp()
    const file = path.join(dir, RESULTS_PATH)
    const description = `${'a'.repeat(252)}é${'z'.repeat(20)}`
    await appendRow(file, row({ description }))
    const loaded = await loadRows(file)
    const got = loaded[0]?.description ?? ''
    expect(got).not.toMatch(/�/)
    expect(got).toBe(`${'a'.repeat(252)}é...`)
  })

  it('truncates by Unicode code point, not UTF-16 code unit: an astral character (surrogate pair) at the cut is kept whole', async () => {
    // U+1F600 is one code point but two UTF-16 code units (a surrogate
    // pair). Placed as the 253rd code point, a naive `.slice` on UTF-16
    // units would land inside the pair and keep only a lone, unpaired
    // surrogate -- an invalid string. A code-point-aware cut keeps it whole.
    const dir = await tmp()
    const file = path.join(dir, RESULTS_PATH)
    const description = `${'a'.repeat(252)}😀${'z'.repeat(20)}`
    await appendRow(file, row({ description }))
    const loaded = await loadRows(file)
    const got = loaded[0]?.description ?? ''
    expect(Array.from(got)).toEqual([...'a'.repeat(252), '😀', '.', '.', '.'])
    // 256 code points, but 257 UTF-16 code units, since the emoji is a
    // surrogate pair -- exactly the distinction this test exists to check.
    expect(Array.from(got)).toHaveLength(256)
    expect(got).toHaveLength(257)
  })

  it('reads back multiple appended rows in order, tolerating the trailing newline', async () => {
    const dir = await tmp()
    const file = path.join(dir, RESULTS_PATH)
    await appendRow(file, row({ commit: 'one' }))
    await appendRow(file, row({ commit: 'two' }))
    await appendRow(file, row({ commit: 'three' }))
    const loaded = await loadRows(file)
    expect(loaded.map((r) => r.commit)).toEqual(['one', 'two', 'three'])
  })

  it('fails the whole load on a malformed line, naming the file and line number', async () => {
    const dir = await tmp()
    const file = path.join(dir, RESULTS_PATH)
    await writeFile(file, `${HEADER}\nonly\ttwo\tfields\n`, 'utf8')
    await expect(loadRows(file)).rejects.toThrow(new RegExp(`${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:2:`))
    await expect(loadRows(file)).rejects.toThrow(/got 3 fields, want 7/)
  })

  it('names the correct line number for a malformed line further down the file', async () => {
    const dir = await tmp()
    const file = path.join(dir, RESULTS_PATH)
    await appendRow(file, row({ commit: 'good-one' }))
    await appendRow(file, row({ commit: 'good-two' }))
    // Hand-corrupt by appending a short line directly.
    const text = await readFile(file, 'utf8')
    await writeFile(file, `${text}broken\tline\n`, 'utf8')
    await expect(loadRows(file)).rejects.toThrow(/:4:/)
  })
})

describe('summarize', () => {
  it('on an empty log returns a cumulative speedup of 1 and no counts', () => {
    const s = summarize([])
    expect(s.cumulativeSpeedup).toBe(1)
    expect(s.counts).toEqual({})
    expect(s.topWins).toEqual([])
  })

  it('computes cumulative speedup as the product of kept scores, not the latest', () => {
    const rows: Row[] = [
      { commit: 'a', score: 0.8, bestBenchDelta: -20, pMin: 0.001, status: 'keep', reason: '', description: '' },
      { commit: 'b', score: 0.5, bestBenchDelta: -50, pMin: 0.001, status: 'keep', reason: '', description: '' },
      {
        commit: 'c',
        score: 1.1,
        bestBenchDelta: 10,
        pMin: 0.9,
        status: 'discard',
        reason: 'no_significant_improvement',
        description: '',
      },
    ]
    expect(summarize(rows).cumulativeSpeedup).toBeCloseTo(0.4, 9)
    expect(summarize(rows).counts['keep']).toBe(2)
    expect(summarize(rows).counts['discard']).toBe(1)
  })

  it('counts every status that appears, including fail and crash', () => {
    const rows: Row[] = [
      row({ status: 'keep' }),
      row({ status: 'fail', reason: '' }),
      row({ status: 'crash', reason: '' }),
      row({ status: 'discard', reason: 'significant_regression' }),
    ]
    const s = summarize(rows)
    expect(s.counts).toEqual({ keep: 1, fail: 1, crash: 1, discard: 1 })
  })

  it('returns at most the three kept rows with the lowest (best) score', () => {
    const rows: Row[] = [
      row({ commit: 'a', score: 0.95 }),
      row({ commit: 'b', score: 0.5 }),
      row({ commit: 'c', score: 0.7 }),
      row({ commit: 'd', score: 0.9 }),
      row({ commit: 'e', score: 0.6 }),
      row({ commit: 'f', status: 'discard', reason: 'no_significant_improvement', score: 0.1 }),
    ]
    const s = summarize(rows)
    expect(s.topWins.map((r) => r.commit)).toEqual(['b', 'e', 'c'])
  })

  it('does not divide by zero or produce NaN when there are no keep rows', () => {
    const rows: Row[] = [row({ status: 'discard', reason: 'no_significant_improvement' })]
    const s = summarize(rows)
    expect(s.cumulativeSpeedup).toBe(1)
    expect(Number.isNaN(s.cumulativeSpeedup)).toBe(false)
    expect(s.topWins).toEqual([])
  })
})
