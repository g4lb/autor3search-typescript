import { countWords } from './wordcount.ts'

// A short sentence repeated for volume, plus one long unbroken token (the
// kind of thing that shows up for real: a URL, a hash, a base64 blob). Short
// words never make the O(n^2) rebuild in countWords visible -- n stays too
// small per word -- so the long token is what actually exercises the bug.
const input = `${'The Quick, Brown Fox! jumps over 2 lazy dogs. '.repeat(200)} ${'x'.repeat(4000)}`

/**
 * Returned so the harness can sink it -- without that, V8 may decide the
 * call is dead and delete it, and the benchmark measures nothing while
 * still looking healthy.
 */
export function benchCountWords(): Map<string, number> {
  return countWords(input)
}
