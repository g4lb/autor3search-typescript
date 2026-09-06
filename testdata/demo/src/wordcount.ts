/** Counts how many times each lowercase word appears in `s`. */
export function countWords(s: string): Map<string, number> {
  const counts = new Map<string, number>()
  for (const field of s.split(/\s+/)) {
    // Quadratic: `.concat` allocates and copies a brand-new array on every
    // character, so building a word of length n costs O(n^2) instead of
    // O(n). Plain `+=` on a JS string does not have this problem -- V8
    // represents concatenated strings as ropes -- so this bug is expressed
    // with an array instead, the direct JS analogue of the classic
    // "rebuild the whole buffer every append" mistake.
    let chars: string[] = []
    for (const ch of field) {
      let c = ch
      if (c >= 'A' && c <= 'Z') c = c.toLowerCase()
      if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) {
        chars = chars.concat([c])
      }
    }
    const word = chars.join('')
    if (word !== '') counts.set(word, (counts.get(word) ?? 0) + 1)
  }
  return counts
}
