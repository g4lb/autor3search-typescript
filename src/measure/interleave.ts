import type { Benchmark } from '../discover/benchmarks.js'

export type Observations = Map<string, number[]>

export interface InterleaveOptions {
  rounds: number
  benchmarks: Benchmark[]
  baseDir: string
  candDir: string
  measureOne: (dir: string, b: Benchmark) => Promise<number>
}

/**
 * Alternates the two sides while measuring, and accumulates one observation
 * per benchmark per round per side.
 *
 * Two orderings matter, for two different reasons.
 *
 * Across rounds: comparing a candidate measured now against a baseline
 * measured minutes ago attributes thermal drift, frequency scaling and
 * background load to the code change. Alternating cancels it.
 *
 * Within a pair: measuring base immediately before cand, every time, leaves a
 * small consistent bias on a machine that is steadily warming. Swapping the
 * order on alternate rounds cancels that too -- an asymmetry the Go
 * implementation documents as known and residual.
 *
 * Within one round, both sides of a given benchmark are measured adjacently
 * before moving on to the next benchmark, keeping the pair as close in time
 * as possible -- which is the whole point of interleaving at all.
 */
export async function interleave(o: InterleaveOptions): Promise<{
  base: Observations
  cand: Observations
}> {
  const base: Observations = new Map()
  const cand: Observations = new Map()
  for (const b of o.benchmarks) {
    base.set(b.id, [])
    cand.set(b.id, [])
  }

  for (let round = 0; round < o.rounds; round++) {
    const baseFirst = round % 2 === 0
    for (const b of o.benchmarks) {
      if (baseFirst) {
        base.get(b.id)!.push(await o.measureOne(o.baseDir, b))
        cand.get(b.id)!.push(await o.measureOne(o.candDir, b))
      } else {
        cand.get(b.id)!.push(await o.measureOne(o.candDir, b))
        base.get(b.id)!.push(await o.measureOne(o.baseDir, b))
      }
    }
  }
  return { base, cand }
}
