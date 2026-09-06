import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { countWords } from './wordcount.ts'

describe('countWords', () => {
  it('counts repeated words', () => {
    assert.deepEqual(
      [...countWords('the quick brown the')].sort(),
      [
        ['brown', 1],
        ['quick', 1],
        ['the', 2],
      ],
    )
  })

  it('lowercases and strips punctuation', () => {
    assert.deepEqual(
      [...countWords('Hello, WORLD! hello?')].sort(),
      [
        ['hello', 2],
        ['world', 1],
      ],
    )
  })

  it('ignores digits-only and empty fields correctly', () => {
    assert.equal(countWords('a  1 b').get('1'), 1)
  })
})
