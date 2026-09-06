import { describe, expect, it } from 'vitest'
import { interleave } from './interleave.js'

const B = [{ id: 'f:a', file: 'f', fn: 'a' }]

describe('interleave', () => {
  it('collects `rounds` observations per side per benchmark', async () => {
    const { base, cand } = await interleave({
      rounds: 4,
      benchmarks: B,
      baseDir: '/base',
      candDir: '/cand',
      measureOne: async (dir) => (dir === '/base' ? 100 : 50),
    })
    expect(base.get('f:a')).toHaveLength(4)
    expect(cand.get('f:a')).toHaveLength(4)
    expect(base.get('f:a')).toEqual([100, 100, 100, 100])
    expect(cand.get('f:a')).toEqual([50, 50, 50, 50])
  })

  it('alternates which side is measured first, so the within-pair offset cancels', async () => {
    const order: string[] = []
    await interleave({
      rounds: 4,
      benchmarks: B,
      baseDir: '/base',
      candDir: '/cand',
      measureOne: async (dir) => {
        order.push(dir)
        return 1
      },
    })
    expect(order).toEqual(['/base', '/cand', '/cand', '/base', '/base', '/cand', '/cand', '/base'])
  })

  it('measures both sides of one benchmark adjacently before moving to the next', async () => {
    const two = [
      { id: 'f:a', file: 'f', fn: 'a' },
      { id: 'f:b', file: 'f', fn: 'b' },
    ]
    const order: string[] = []
    await interleave({
      rounds: 1,
      benchmarks: two,
      baseDir: '/base',
      candDir: '/cand',
      measureOne: async (dir, b) => {
        order.push(`${b.id}@${dir}`)
        return 1
      },
    })
    expect(order).toEqual(['f:a@/base', 'f:a@/cand', 'f:b@/base', 'f:b@/cand'])
  })

  it('accepts a single round, because round-count validation lives in config', async () => {
    // config refuses count < 4; interleave itself must stay usable at any
    // round count so tests and the baseline smoke run can call it with 1.
    const { base } = await interleave({
      rounds: 1,
      benchmarks: B,
      baseDir: '/b',
      candDir: '/c',
      measureOne: async () => 1,
    })
    expect(base.get('f:a')).toEqual([1])
  })

  it('accumulates observations across multiple benchmarks independently', async () => {
    const two = [
      { id: 'f:a', file: 'f', fn: 'a' },
      { id: 'f:b', file: 'f', fn: 'b' },
    ]
    const { base, cand } = await interleave({
      rounds: 2,
      benchmarks: two,
      baseDir: '/base',
      candDir: '/cand',
      measureOne: async (dir, b) => (b.id === 'f:a' ? (dir === '/base' ? 1 : 2) : dir === '/base' ? 10 : 20),
    })
    expect(base.get('f:a')).toEqual([1, 1])
    expect(cand.get('f:a')).toEqual([2, 2])
    expect(base.get('f:b')).toEqual([10, 10])
    expect(cand.get('f:b')).toEqual([20, 20])
  })
})
