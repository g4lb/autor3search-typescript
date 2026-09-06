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

  it('counts a digits-only word like any other, and does not choke on the empty field a double space produces', () => {
    assert.equal(countWords('a  1 b').get('1'), 1)
  })
})
