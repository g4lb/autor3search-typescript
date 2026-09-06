import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  checkCpuGovernorAt,
  checkDiskSpace,
  checkOnBatteryLinux,
  cpuGovernorVerdict,
  diskSpaceVerdict,
  loadAverageVerdict,
  nodeVersionVerdict,
  pmsetBatteryVerdict,
  runChecks,
} from './doctor.js'

const tmpDirs: string[] = []

async function tmpDir(prefix: string): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), prefix))
  tmpDirs.push(d)
  return d
}

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

describe('runChecks', () => {
  it('returns a non-empty array', async () => {
    const checks = await runChecks()
    expect(checks.length).toBeGreaterThan(0)
  })

  it('gives every check a non-empty name and detail, and a boolean ok', async () => {
    const checks = await runChecks()
    for (const c of checks) {
      expect(c.name.length).toBeGreaterThan(0)
      expect(c.detail.length).toBeGreaterThan(0)
      expect(typeof c.ok).toBe('boolean')
    }
  })

  it('produces distinct check names -- one row per probe, not duplicates', async () => {
    const checks = await runChecks()
    const names = checks.map((c) => c.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('never rejects, even run concurrently', async () => {
    await expect(Promise.all([runChecks(), runChecks(), runChecks()])).resolves.toBeDefined()
  })
})

describe('checkDiskSpace (probe pointed at a path that certainly does not exist)', () => {
  it('degrades to ok:true with an explicit "not available" detail, never throwing', async () => {
    const bogus = path.join(
      tmpdir(),
      `ars-doctor-does-not-exist-${Math.random().toString(36).slice(2)}`,
    )
    const check = await checkDiskSpace(bogus)
    expect(check.ok).toBe(true)
    expect(check.detail).toMatch(/not available on this platform/)
  })

  it('reports a real free-space figure for a directory that does exist', async () => {
    const dir = await tmpDir('ars-doctor-disk-')
    const check = await checkDiskSpace(dir)
    expect(check.name).toBe('disk-space')
    expect(check.detail).toMatch(/GB free/)
  })
})

describe('diskSpaceVerdict (pure threshold logic)', () => {
  const GIB = 1024 ** 3

  it('flags free space below the 2 GB floor', () => {
    const v = diskSpaceVerdict(1 * GIB, '/some/dir')
    expect(v.ok).toBe(false)
    expect(v.detail).toMatch(/2 GB/)
    expect(v.detail).toMatch(/1\.0 GB free/)
  })

  it('passes free space at or above the 2 GB floor', () => {
    const v = diskSpaceVerdict(50 * GIB, '/some/dir')
    expect(v.ok).toBe(true)
    expect(v.detail).toMatch(/50\.0 GB free/)
  })

  it('treats exactly 2 GB as passing (a floor, not a strict inequality)', () => {
    const v = diskSpaceVerdict(2 * GIB, '/some/dir')
    expect(v.ok).toBe(true)
  })
})

describe('nodeVersionVerdict', () => {
  it('rejects a Node major version below 22', () => {
    const v = nodeVersionVerdict('v21.7.3')
    expect(v.ok).toBe(false)
    expect(v.detail).toMatch(/21\.7\.3/)
  })

  it('accepts Node 22 exactly', () => {
    expect(nodeVersionVerdict('v22.0.0').ok).toBe(true)
  })

  it('accepts a Node major version above 22', () => {
    expect(nodeVersionVerdict('v23.4.0').ok).toBe(true)
  })
})

describe('loadAverageVerdict', () => {
  it('warns when 1-minute load approaches saturation relative to core count', () => {
    const v = loadAverageVerdict(7.8, 8)
    expect(v.ok).toBe(false)
    expect(v.detail).toMatch(/8 core/)
  })

  it('passes a quiet machine with load well under its core count', () => {
    const v = loadAverageVerdict(0.5, 8)
    expect(v.ok).toBe(true)
  })

  it('judges the same raw load differently depending on core count', () => {
    // A load of 4 means opposite things on a 4-core and a 64-core machine.
    const busy = loadAverageVerdict(4, 4)
    const idle = loadAverageVerdict(4, 64)
    expect(busy.ok).toBe(false)
    expect(idle.ok).toBe(true)
  })
})

describe('cpuGovernorVerdict', () => {
  it('passes the "performance" governor', () => {
    expect(cpuGovernorVerdict('performance').ok).toBe(true)
  })

  it('warns on "powersave" and names the offending governor', () => {
    const v = cpuGovernorVerdict('powersave')
    expect(v.ok).toBe(false)
    expect(v.detail).toMatch(/powersave/)
  })

  it('warns on "ondemand"', () => {
    expect(cpuGovernorVerdict('ondemand').ok).toBe(false)
  })
})

describe('checkCpuGovernorAt (Linux sysfs shape, fixtured -- not run against a real Linux kernel)', () => {
  it('degrades to ok:true when the sysfs file is absent', async () => {
    const bogus = path.join(tmpdir(), `ars-doctor-no-governor-${Math.random().toString(36).slice(2)}`)
    const check = await checkCpuGovernorAt(bogus)
    expect(check.ok).toBe(true)
    expect(check.detail).toMatch(/not available on this platform/)
  })

  it('reads a fixture file reporting "performance"', async () => {
    const dir = await tmpDir('ars-doctor-gov-')
    const file = path.join(dir, 'scaling_governor')
    await writeFile(file, 'performance\n', 'utf8')
    const check = await checkCpuGovernorAt(file)
    expect(check.ok).toBe(true)
  })

  it('reads a fixture file reporting "powersave" and flags it', async () => {
    const dir = await tmpDir('ars-doctor-gov-')
    const file = path.join(dir, 'scaling_governor')
    await writeFile(file, 'powersave\n', 'utf8')
    const check = await checkCpuGovernorAt(file)
    expect(check.ok).toBe(false)
    expect(check.detail).toMatch(/powersave/)
  })
})

describe('pmsetBatteryVerdict (macOS pmset output parsing)', () => {
  it('reports on-AC when pmset says so', () => {
    const v = pmsetBatteryVerdict("Now drawing from 'AC Power'\n -InternalBattery-0\t100%; charged\n")
    expect(v.ok).toBe(true)
    expect(v.detail).toMatch(/AC power/i)
  })

  it('flags battery power and explains the risk', () => {
    const v = pmsetBatteryVerdict("Now drawing from 'Battery Power'\n -InternalBattery-0\t54%; discharging\n")
    expect(v.ok).toBe(false)
    expect(v.detail).toMatch(/battery/i)
  })
})

describe('checkOnBatteryLinux (sysfs shape, fixtured -- not run against a real Linux kernel)', () => {
  it('degrades to ok:true when /sys/class/power_supply does not exist', async () => {
    const bogus = path.join(tmpdir(), `ars-doctor-no-power-${Math.random().toString(36).slice(2)}`)
    const check = await checkOnBatteryLinux(bogus)
    expect(check.ok).toBe(true)
    expect(check.detail).toMatch(/not available on this platform/)
  })

  it('reports ok:true with no batteries present (desktop/VM)', async () => {
    const dir = await tmpDir('ars-doctor-power-')
    const check = await checkOnBatteryLinux(dir)
    expect(check.ok).toBe(true)
    expect(check.detail).toMatch(/no battery/i)
  })

  it('flags a discharging battery', async () => {
    const dir = await tmpDir('ars-doctor-power-')
    await mkdir(path.join(dir, 'BAT0'))
    await writeFile(path.join(dir, 'BAT0', 'status'), 'Discharging\n', 'utf8')
    const check = await checkOnBatteryLinux(dir)
    expect(check.ok).toBe(false)
    expect(check.detail).toMatch(/Discharging/)
  })

  it('passes a charging battery', async () => {
    const dir = await tmpDir('ars-doctor-power-')
    await mkdir(path.join(dir, 'BAT0'))
    await writeFile(path.join(dir, 'BAT0', 'status'), 'Charging\n', 'utf8')
    const check = await checkOnBatteryLinux(dir)
    expect(check.ok).toBe(true)
  })
})
