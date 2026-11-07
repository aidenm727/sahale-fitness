import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../server/config'
import { harness, tempDir } from './helpers'

const ORIGIN = 'https://laptop.example-tailnet.ts.net'
const HOST = 'laptop.example-tailnet.ts.net'
const OWNER = 'owner@example.com'
const PRIVATE = { publicOrigin: ORIGIN, ownerLogin: OWNER }

const env = (over: Record<string, string> = {}) => ({ SAHALE_DATA_DIR: tempDir(), ...over })

/**
 * A request as Tailscale Serve forwards it: the browser's Host unchanged, plus the identity
 * header Serve sets for an identified, untagged peer. `login: null` = no identity (Funnel,
 * a tagged device, or something that didn't come through Serve).
 */
async function send(
  app: FastifyInstance,
  method: 'GET' | 'POST',
  url: string,
  opts: { host?: string; login?: string | null; origin?: string; client?: boolean; headers?: Record<string, string>; body?: unknown } = {},
) {
  const headers: Record<string, string> = { host: opts.host ?? HOST, ...opts.headers }
  const login = opts.login === undefined ? OWNER : opts.login
  if (login !== null) headers['tailscale-user-login'] = login
  if (opts.origin) headers.origin = opts.origin
  if (opts.client ?? method !== 'GET') headers['x-sahale-client'] = '1'
  if (opts.body !== undefined) headers['content-type'] = 'application/json'
  const res = await app.inject({ method, url, headers, ...(opts.body !== undefined ? { payload: JSON.stringify(opts.body) } : {}) })
  return { status: res.statusCode, code: res.headers['content-type']?.includes('json') ? (JSON.parse(res.body) as { code?: string }).code : undefined, body: res.body }
}

describe('private access configuration', () => {
  it('is off unless SAHALE_PUBLIC_ORIGIN is set', () => {
    const c = loadConfig(env())
    expect(c).toMatchObject({ host: '127.0.0.1', publicOrigin: null, ownerLogin: null })
  })

  it('takes one HTTPS origin and the owner login, without widening the loopback origins', () => {
    const c = loadConfig(env({ SAHALE_PUBLIC_ORIGIN: `${ORIGIN}/`, SAHALE_OWNER_LOGIN: OWNER }))
    expect(c).toMatchObject({ host: '127.0.0.1', publicOrigin: ORIGIN, ownerLogin: OWNER })
    expect(c.allowedOrigins).not.toContain(ORIGIN)
  })

  it.each([
    'http://laptop.example-tailnet.ts.net',
    'https://laptop.example-tailnet.ts.net/app',
    'https://laptop.example-tailnet.ts.net?x=1',
    'https://user:pw@laptop.example-tailnet.ts.net',
    'https://*.example-tailnet.ts.net',
    'https://100.101.102.103',
    'https://localhost',
    `${ORIGIN},https://other.example-tailnet.ts.net`,
    '*',
  ])('refuses SAHALE_PUBLIC_ORIGIN=%s', (origin) => {
    expect(() => loadConfig(env({ SAHALE_PUBLIC_ORIGIN: origin, SAHALE_OWNER_LOGIN: OWNER }))).toThrow(/SAHALE_PUBLIC_ORIGIN must be one HTTPS origin/)
  })

  it('needs both settings together, and a plain owner login', () => {
    expect(() => loadConfig(env({ SAHALE_PUBLIC_ORIGIN: ORIGIN }))).toThrow(/requires SAHALE_OWNER_LOGIN/)
    expect(() => loadConfig(env({ SAHALE_OWNER_LOGIN: OWNER }))).toThrow(/only applies together with SAHALE_PUBLIC_ORIGIN/)
    expect(() => loadConfig(env({ SAHALE_PUBLIC_ORIGIN: ORIGIN, SAHALE_OWNER_LOGIN: 'two words' }))).toThrow(/plain ASCII/)
    expect(() => loadConfig(env({ SAHALE_PUBLIC_ORIGIN: ORIGIN, SAHALE_OWNER_LOGIN: 'jürgen@example.com' }))).toThrow(/plain ASCII/)
  })

  it('refuses a public origin unless the runtime listens on loopback', () => {
    expect(() => loadConfig(env({ SAHALE_PUBLIC_ORIGIN: ORIGIN, SAHALE_OWNER_LOGIN: OWNER, SAHALE_HOST: '0.0.0.0' }))).toThrow(/loopback/)
    expect(() => loadConfig(env({ SAHALE_PUBLIC_ORIGIN: ORIGIN, SAHALE_OWNER_LOGIN: OWNER, SAHALE_HOST: '100.101.102.103' }))).toThrow(/loopback/)
    expect(loadConfig(env({ SAHALE_PUBLIC_ORIGIN: ORIGIN, SAHALE_OWNER_LOGIN: OWNER, SAHALE_HOST: 'localhost' })).host).toBe('localhost')
  })
})

describe('access through Tailscale Serve', () => {
  it('lets the owner read and write through the public origin', async () => {
    const h = await harness({ config: PRIVATE })
    expect((await send(h.app, 'GET', '/api/fitness')).status).toBe(200)
    expect((await send(h.app, 'GET', '/api/fitness', { host: HOST.toUpperCase() })).status).toBe(200)
    expect((await send(h.app, 'GET', '/api/fitness', { login: 'Owner@Example.com' })).status).toBe(200)
    const write = await send(h.app, 'POST', '/api/fitness/notes', { origin: ORIGIN, body: { text: 'from the phone' } })
    expect(write.status).toBe(201)
    expect((await h.call('GET', '/api/fitness')).body.notes.map((n: { text: string }) => n.text)).toContain('from the phone')
  })

  it('refuses the public host without the owner identity, for pages as well as the API', async () => {
    const h = await harness({ config: PRIVATE })
    expect(await send(h.app, 'GET', '/api/fitness', { login: null })).toMatchObject({ status: 403, code: 'forbidden_identity' })
    expect(await send(h.app, 'GET', '/api/fitness', { login: '' })).toMatchObject({ status: 403, code: 'forbidden_identity' })
    expect(await send(h.app, 'GET', '/api/fitness', { login: 'someone-else@example.com' })).toMatchObject({ status: 403, code: 'forbidden_identity' })
    expect(await send(h.app, 'GET', '/api/fitness', { login: `${OWNER}.evil` })).toMatchObject({ status: 403, code: 'forbidden_identity' })
    expect(await send(h.app, 'POST', '/api/fitness/notes', { login: 'someone-else@example.com', origin: ORIGIN, body: { text: 'x' } })).toMatchObject({ status: 403, code: 'forbidden_identity' })
    // Funnel traffic is marked by Serve and never carries a user identity; refuse it outright.
    expect(await send(h.app, 'GET', '/api/fitness', { headers: { 'tailscale-funnel-request': '?1' } })).toMatchObject({ status: 403, code: 'forbidden_identity' })
    expect(await send(h.app, 'GET', '/', { login: null })).toMatchObject({ status: 403, code: 'forbidden_identity' })
    expect((await h.call('GET', '/api/fitness')).body.notes).toEqual([])
  })

  it('refuses other origins and writes without the UI header, even from the owner', async () => {
    const h = await harness({ config: PRIVATE })
    const note = { body: { text: 'x' } }
    expect(await send(h.app, 'POST', '/api/fitness/notes', { ...note, origin: `http://${HOST}` })).toMatchObject({ status: 403, code: 'forbidden_origin' })
    expect(await send(h.app, 'POST', '/api/fitness/notes', { ...note, origin: 'https://evil.example' })).toMatchObject({ status: 403, code: 'forbidden_origin' })
    expect(await send(h.app, 'POST', '/api/fitness/notes', { ...note, origin: 'http://localhost:5173' })).toMatchObject({ status: 403, code: 'forbidden_origin' })
    expect(await send(h.app, 'POST', '/api/fitness/notes', { ...note, origin: ORIGIN, client: false })).toMatchObject({ status: 403, code: 'missing_client_header' })
    expect((await h.call('GET', '/api/fitness')).body.notes).toEqual([])
  })

  it('answers no other host, whatever identity comes with it', async () => {
    const h = await harness({ config: PRIVATE })
    for (const host of ['other.example-tailnet.ts.net', '100.101.102.103', `${HOST}:4310`, `${HOST}.evil.example`, 'evil.example']) {
      expect(await send(h.app, 'GET', '/api/fitness', { host })).toMatchObject({ status: 403, code: 'forbidden_host' })
      expect(await send(h.app, 'GET', '/', { host })).toMatchObject({ status: 403, code: 'forbidden_host' })
    }
  })

  it('treats the tailnet host as forbidden when no public origin is configured', async () => {
    const h = await harness()
    expect(await send(h.app, 'GET', '/api/fitness')).toMatchObject({ status: 403, code: 'forbidden_host' })
    expect(await send(h.app, 'POST', '/api/fitness/notes', { origin: ORIGIN, body: { text: 'x' } })).toMatchObject({ status: 403, code: 'forbidden_host' })
  })

  it('leaves local access as it was', async () => {
    const h = await harness({ config: PRIVATE })
    const local = { host: '127.0.0.1:4310', login: null }
    expect((await send(h.app, 'GET', '/api/fitness', local)).status).toBe(200)
    expect((await send(h.app, 'GET', '/api/fitness', { ...local, host: 'localhost:5173' })).status).toBe(200)
    expect((await send(h.app, 'POST', '/api/fitness/notes', { ...local, origin: 'http://localhost:5173', body: { text: 'dev' } })).status).toBe(201)
    expect((await h.call('POST', '/api/fitness/notes', { text: 'local' })).status).toBe(201)
    // The public origin is not a loopback origin.
    expect(await send(h.app, 'POST', '/api/fitness/notes', { ...local, origin: ORIGIN, body: { text: 'x' } })).toMatchObject({ status: 403, code: 'forbidden_origin' })
    expect(await send(h.app, 'POST', '/api/fitness/notes', { ...local, body: { text: 'x' }, client: false })).toMatchObject({ status: 403, code: 'missing_client_header' })
    expect((await h.call('GET', '/api/fitness')).body.notes.map((n: { text: string }) => n.text).sort()).toEqual(['dev', 'local'])
  })

  it('serves the built UI to the owner through the proxy and locally, to no one else', async () => {
    const distDir = tempDir()
    writeFileSync(join(distDir, 'index.html'), '<!doctype html><title>Sahale</title>')
    const h = await harness({ config: { ...PRIVATE, serveStatic: true, distDir } })
    expect(await send(h.app, 'GET', '/')).toMatchObject({ status: 200, body: expect.stringContaining('<title>Sahale</title>') })
    expect(await send(h.app, 'GET', '/today')).toMatchObject({ status: 200, body: expect.stringContaining('<title>Sahale</title>') })
    expect((await send(h.app, 'GET', '/', { host: '127.0.0.1:4310', login: null })).status).toBe(200)
    expect(await send(h.app, 'GET', '/today', { login: null })).toMatchObject({ status: 403, code: 'forbidden_identity' })
    expect(await send(h.app, 'GET', '/', { login: 'someone-else@example.com' })).toMatchObject({ status: 403, code: 'forbidden_identity' })
  })
})

describe('a Serve port other than 443', () => {
  // On a host where another proxy already owns :443 on the tailnet address, Serve listens on
  // e.g. :8443 and the browser's Host and Origin carry that port.
  const PORTED = { publicOrigin: `${ORIGIN}:8443`, ownerLogin: OWNER }

  it('is accepted as the public origin', () => {
    expect(loadConfig(env({ SAHALE_PUBLIC_ORIGIN: `${ORIGIN}:8443`, SAHALE_OWNER_LOGIN: OWNER })).publicOrigin).toBe(`${ORIGIN}:8443`)
  })

  it('answers the owner on that host:port only', async () => {
    const h = await harness({ config: PORTED })
    expect((await send(h.app, 'GET', '/api/fitness', { host: `${HOST}:8443` })).status).toBe(200)
    expect((await send(h.app, 'POST', '/api/fitness/notes', { host: `${HOST}:8443`, origin: `${ORIGIN}:8443`, body: { text: 'ported' } })).status).toBe(201)
    expect(await send(h.app, 'GET', '/api/fitness', { host: `${HOST}:8443`, login: null })).toMatchObject({ status: 403, code: 'forbidden_identity' })
    // The default-port host is a different origin, owned by the other proxy.
    expect(await send(h.app, 'GET', '/api/fitness', { host: HOST })).toMatchObject({ status: 403, code: 'forbidden_host' })
    expect(await send(h.app, 'POST', '/api/fitness/notes', { host: `${HOST}:8443`, origin: ORIGIN, body: { text: 'x' } })).toMatchObject({ status: 403, code: 'forbidden_origin' })
    expect((await h.call('GET', '/api/fitness')).body.notes.map((n: { text: string }) => n.text)).toEqual(['ported'])
  })
})
