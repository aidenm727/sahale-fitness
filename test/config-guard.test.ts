import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig, ROOT } from '../server/config'
import { tempDir } from './helpers'

const share = join(homedir(), '.local', 'share')
const refused = [
  join(share, 'sahale'),
  join(share, 'sahale', 'backups'),
  join(share, 'sahale-s2-trial'),
  join(share, 'sahale-dev'),
  join(share, 'aiden-platform'),
  '/var/lib/sahale',
  '/var/lib/sahale-rehearsal',
  join(homedir(), 'sahale-release'),
  join(homedir(), 'sahale-release', 'v041', 'cp2'),
]

describe('data dir: development', () => {
  it('defaults to .data/dev in the checkout when unset', () => {
    const c = loadConfig({})
    expect(c.dataDir).toBe(join(ROOT, '.data', 'dev'))
    expect(c.dbPath).toBe(join(ROOT, '.data', 'dev', 'sahale.db'))
  })

  it.each(refused)('refuses %s', (dir) => {
    expect(() => loadConfig({ SAHALE_DATA_DIR: dir })).toThrow(/Refusing SAHALE_DATA_DIR=.*SAHALE_ALLOW_DATA_DIR=/)
  })

  it('names the path and the bypass in the error', () => {
    const dir = join(share, 'sahale-s2-trial')
    expect(() => loadConfig({ SAHALE_DATA_DIR: dir })).toThrow(`SAHALE_ALLOW_DATA_DIR=${dir}`)
  })

  it('refuses a relative path and a trailing slash that land on a real store', () => {
    expect(() => loadConfig({ SAHALE_DATA_DIR: join(share, 'sahale') + '/' })).toThrow(/Refusing/)
    expect(() => loadConfig({ SAHALE_DATA_DIR: join(share, 'x', '..', 'sahale-pilot') })).toThrow(/Refusing/)
  })

  it('accepts the exact bypass', () => {
    for (const dir of refused) {
      expect(loadConfig({ SAHALE_DATA_DIR: dir, SAHALE_ALLOW_DATA_DIR: dir }).dataDir).toBe(dir)
    }
  })

  it('refuses a near-miss bypass', () => {
    const dir = join(share, 'sahale-s2-trial')
    for (const allow of [
      dir + '-x',
      join(dir, 'sub'),
      share,
      join(share, 'sahale-*'),
      '1',
      'sahale-s2-trial',
      '',
    ]) {
      expect(() => loadConfig({ SAHALE_DATA_DIR: dir, SAHALE_ALLOW_DATA_DIR: allow })).toThrow(/Refusing/)
    }
    // A bypass for one path does not open its child.
    expect(() => loadConfig({ SAHALE_DATA_DIR: join(dir, 'objects'), SAHALE_ALLOW_DATA_DIR: dir })).toThrow(/Refusing/)
  })

  it('leaves other directories alone', () => {
    const tmp = tempDir()
    expect(loadConfig({ SAHALE_DATA_DIR: tmp }).dataDir).toBe(tmp)
    expect(loadConfig({ SAHALE_DATA_DIR: join(share, 'other') }).dataDir).toBe(join(share, 'other'))
    expect(loadConfig({ SAHALE_DATA_DIR: join(share, 'sahalefoo') }).dataDir).toBe(join(share, 'sahalefoo'))
    expect(loadConfig({ SAHALE_DATA_DIR: resolve('.data/dev') }).dataDir).toBe(join(ROOT, '.data', 'dev'))
  })
})

describe('data dir: production', () => {
  it('accepts an explicit dir, including the host store', () => {
    expect(loadConfig({ NODE_ENV: 'production', SAHALE_DATA_DIR: '/var/lib/sahale' }).dataDir).toBe('/var/lib/sahale')
  })

  it('errors when the dir is unset', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/SAHALE_DATA_DIR must be set explicitly in production/)
  })
})
