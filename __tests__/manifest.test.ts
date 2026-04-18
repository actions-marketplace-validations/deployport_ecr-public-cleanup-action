import { jest } from '@jest/globals'
import {
  buildManifestUrl,
  createManifestFetcher,
  parseBearerChallenge,
  parseRetryAfter
} from '../src/manifest.js'

describe('buildManifestUrl', () => {
  it('constructs the registry manifest URL from image-uri and digest', () => {
    expect(
      buildManifestUrl('public.ecr.aws/o6c5x4x5/gatun/agent', 'sha256:abc')
    ).toBe(
      'https://public.ecr.aws/v2/o6c5x4x5/gatun/agent/manifests/sha256:abc'
    )
  })

  it('strips an https:// prefix if present', () => {
    expect(
      buildManifestUrl('https://public.ecr.aws/foo/bar', 'sha256:xyz')
    ).toBe('https://public.ecr.aws/v2/foo/bar/manifests/sha256:xyz')
  })

  it('throws when image-uri has no path component', () => {
    expect(() => buildManifestUrl('public.ecr.aws', 'sha256:abc')).toThrow(
      /host\/repo-path/
    )
  })
})

describe('parseBearerChallenge', () => {
  it('parses ECR Public style challenge (realm, service, scope)', () => {
    expect(
      parseBearerChallenge(
        'Bearer realm="https://public.ecr.aws/token/",service="public.ecr.aws",scope="aws:repository:gatun/agent:pull"'
      )
    ).toEqual({
      realm: 'https://public.ecr.aws/token/',
      service: 'public.ecr.aws',
      scope: 'aws:repository:gatun/agent:pull'
    })
  })

  it('parses a challenge with only a realm parameter', () => {
    expect(parseBearerChallenge('Bearer realm="https://foo/"')).toEqual({
      realm: 'https://foo/',
      service: undefined,
      scope: undefined
    })
  })

  it('returns null for non-Bearer schemes (e.g. Basic)', () => {
    expect(parseBearerChallenge('Basic realm="foo"')).toBeNull()
  })

  it('returns null when realm is missing', () => {
    expect(parseBearerChallenge('Bearer service="x",scope="y"')).toBeNull()
  })
})

describe('parseRetryAfter', () => {
  it('parses a numeric delay-seconds value into milliseconds', () => {
    expect(parseRetryAfter('5')).toBe(5000)
  })

  it('parses zero seconds', () => {
    expect(parseRetryAfter('0')).toBe(0)
  })

  it('parses an HTTP-date into milliseconds from now (non-negative)', () => {
    const future = new Date(Date.now() + 10_000).toUTCString()
    const ms = parseRetryAfter(future)
    expect(ms).not.toBeNull()
    expect(ms!).toBeGreaterThan(8_000)
    expect(ms!).toBeLessThanOrEqual(10_000)
  })

  it('returns null for null / missing header', () => {
    expect(parseRetryAfter(null)).toBeNull()
  })

  it('returns null for malformed values', () => {
    expect(parseRetryAfter('not a number or a date')).toBeNull()
  })
})

const okJson = (body: unknown): Response =>
  ({
    ok: true,
    status: 200,
    json: async () => body
  }) as unknown as Response

const errStatus = (status: number): Response =>
  ({
    ok: false,
    status,
    headers: { get: () => null }
  }) as unknown as Response

const unauthorized = (wwwAuthenticate: string | null): Response =>
  ({
    ok: false,
    status: 401,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === 'www-authenticate' ? wwwAuthenticate : null
    }
  }) as unknown as Response

const rateLimited = (retryAfter: string | null): Response =>
  ({
    ok: false,
    status: 429,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === 'retry-after' ? retryAfter : null
    }
  }) as unknown as Response

const CHALLENGE_HEADER =
  'Bearer realm="https://public.ecr.aws/token/",service="public.ecr.aws",scope="aws:repository:foo/bar:pull"'

describe('createManifestFetcher', () => {
  it('returns child digests when the registry replies 200 directly', async () => {
    const fetchFn = jest.fn<typeof fetch>().mockResolvedValue(
      okJson({
        mediaType: 'application/vnd.oci.image.index.v1+json',
        manifests: [{ digest: 'sha256:a' }, { digest: 'sha256:b' }]
      })
    )
    const fetch = createManifestFetcher('public.ecr.aws/foo/bar', { fetchFn })
    expect(await fetch('sha256:parent')).toEqual(['sha256:a', 'sha256:b'])
  })

  it('returns [] for a single-arch manifest (no manifests field)', async () => {
    const fetchFn = jest.fn<typeof fetch>().mockResolvedValue(
      okJson({
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
        config: { digest: 'sha256:c' }
      })
    )
    const fetch = createManifestFetcher('public.ecr.aws/foo/bar', { fetchFn })
    expect(await fetch('sha256:single')).toEqual([])
  })

  it('handles the OCI bearer-token challenge flow (401 → token → 200)', async () => {
    const fetchFn = jest
      .fn<typeof fetch>()
      .mockResolvedValueOnce(unauthorized(CHALLENGE_HEADER))
      .mockResolvedValueOnce(okJson({ token: 'test-token' }))
      .mockResolvedValueOnce(
        okJson({
          mediaType: 'application/vnd.oci.image.index.v1+json',
          manifests: [{ digest: 'sha256:a' }]
        })
      )

    const fetch = createManifestFetcher('public.ecr.aws/foo/bar', { fetchFn })
    expect(await fetch('sha256:parent')).toEqual(['sha256:a'])
    expect(fetchFn).toHaveBeenCalledTimes(3)

    const tokenUrl = fetchFn.mock.calls[1][0] as string
    expect(tokenUrl).toContain('https://public.ecr.aws/token/')
    expect(tokenUrl).toContain('service=public.ecr.aws')
    expect(tokenUrl).toContain('scope=aws')

    expect(fetchFn.mock.calls[2][1]).toEqual(
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token'
        })
      })
    )
  })

  it('caches the bearer token across multiple manifest fetches (challenge runs once)', async () => {
    const fetchFn = jest
      .fn<typeof fetch>()
      .mockResolvedValueOnce(unauthorized(CHALLENGE_HEADER))
      .mockResolvedValueOnce(okJson({ token: 'cached-token' }))
      .mockResolvedValueOnce(okJson({ manifests: [{ digest: 'sha256:a' }] }))
      .mockResolvedValueOnce(okJson({ manifests: [{ digest: 'sha256:b' }] }))
      .mockResolvedValueOnce(okJson({ manifests: [{ digest: 'sha256:c' }] }))

    const fetch = createManifestFetcher('public.ecr.aws/foo/bar', { fetchFn })
    expect(await fetch('sha256:p1')).toEqual(['sha256:a'])
    expect(await fetch('sha256:p2')).toEqual(['sha256:b'])
    expect(await fetch('sha256:p3')).toEqual(['sha256:c'])

    expect(fetchFn).toHaveBeenCalledTimes(5)
    const tokenCalls = fetchFn.mock.calls.filter((c) =>
      (c[0] as string).startsWith('https://public.ecr.aws/token/')
    )
    expect(tokenCalls).toHaveLength(1)

    // Every manifest request after the initial 401 carries the cached token.
    for (const idx of [2, 3, 4]) {
      expect(fetchFn.mock.calls[idx][1]).toEqual(
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer cached-token'
          })
        })
      )
    }
  })

  it('accepts "access_token" in the token response (Docker-style)', async () => {
    const fetchFn = jest
      .fn<typeof fetch>()
      .mockResolvedValueOnce(unauthorized(CHALLENGE_HEADER))
      .mockResolvedValueOnce(okJson({ access_token: 'legacy-token' }))
      .mockResolvedValueOnce(okJson({ manifests: [{ digest: 'sha256:ok' }] }))

    const fetch = createManifestFetcher('public.ecr.aws/foo/bar', { fetchFn })
    expect(await fetch('sha256:parent')).toEqual(['sha256:ok'])
  })

  it('retries once on 429 with Retry-After (seconds) and succeeds', async () => {
    const fetchFn = jest
      .fn<typeof fetch>()
      .mockResolvedValueOnce(rateLimited('2'))
      .mockResolvedValueOnce(
        okJson({
          mediaType: 'application/vnd.oci.image.index.v1+json',
          manifests: [{ digest: 'sha256:after-retry' }]
        })
      )
    const sleepFn = jest
      .fn<(ms: number) => Promise<void>>()
      .mockResolvedValue(undefined)

    const fetch = createManifestFetcher('public.ecr.aws/foo/bar', {
      fetchFn,
      sleepFn
    })
    expect(await fetch('sha256:p')).toEqual(['sha256:after-retry'])
    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(sleepFn).toHaveBeenCalledTimes(1)
    expect(sleepFn).toHaveBeenCalledWith(2000)
  })

  it('falls back to exponential backoff when Retry-After is absent', async () => {
    const fetchFn = jest
      .fn<typeof fetch>()
      .mockResolvedValueOnce(rateLimited(null))
      .mockResolvedValueOnce(okJson({ manifests: [] }))
    const sleepFn = jest
      .fn<(ms: number) => Promise<void>>()
      .mockResolvedValue(undefined)

    const fetch = createManifestFetcher('public.ecr.aws/foo/bar', {
      fetchFn,
      sleepFn
    })
    await fetch('sha256:p')
    expect(sleepFn).toHaveBeenCalledWith(1000)
  })

  it('throws with HTTP 429 after exhausting retries', async () => {
    const fetchFn = jest.fn<typeof fetch>().mockResolvedValue(rateLimited('1'))
    const sleepFn = jest
      .fn<(ms: number) => Promise<void>>()
      .mockResolvedValue(undefined)

    const fetch = createManifestFetcher('public.ecr.aws/foo/bar', {
      fetchFn,
      sleepFn,
      maxRetries: 2
    })
    await expect(fetch('sha256:p')).rejects.toThrow('HTTP 429')
    // 1 initial + 2 retries = 3 attempts
    expect(fetchFn).toHaveBeenCalledTimes(3)
    expect(sleepFn).toHaveBeenCalledTimes(2)
  })

  it('throws when 401 response has no WWW-Authenticate header', async () => {
    const fetchFn = jest
      .fn<typeof fetch>()
      .mockResolvedValueOnce(unauthorized(null))
    const fetch = createManifestFetcher('public.ecr.aws/foo/bar', { fetchFn })
    await expect(fetch('sha256:x')).rejects.toThrow(/without WWW-Authenticate/)
  })

  it('throws when auth challenge uses an unsupported scheme', async () => {
    const fetchFn = jest
      .fn<typeof fetch>()
      .mockResolvedValueOnce(unauthorized('Basic realm="foo"'))
    const fetch = createManifestFetcher('public.ecr.aws/foo/bar', { fetchFn })
    await expect(fetch('sha256:x')).rejects.toThrow(
      /unsupported auth challenge/
    )
  })

  it('throws when the token endpoint itself fails', async () => {
    const fetchFn = jest
      .fn<typeof fetch>()
      .mockResolvedValueOnce(unauthorized(CHALLENGE_HEADER))
      .mockResolvedValueOnce(errStatus(500))
    const fetch = createManifestFetcher('public.ecr.aws/foo/bar', { fetchFn })
    await expect(fetch('sha256:x')).rejects.toThrow(
      /token fetch failed: HTTP 500/
    )
  })

  it('throws when the post-auth retry still returns 401 (no infinite loop)', async () => {
    const fetchFn = jest
      .fn<typeof fetch>()
      .mockResolvedValueOnce(unauthorized(CHALLENGE_HEADER))
      .mockResolvedValueOnce(okJson({ token: 't' }))
      .mockResolvedValueOnce(errStatus(401))
    const fetch = createManifestFetcher('public.ecr.aws/foo/bar', { fetchFn })
    await expect(fetch('sha256:x')).rejects.toThrow(/HTTP 401/)
    expect(fetchFn).toHaveBeenCalledTimes(3)
  })

  it('throws fail-loud on 404', async () => {
    const fetchFn = jest.fn<typeof fetch>().mockResolvedValue(errStatus(404))
    const fetch = createManifestFetcher('public.ecr.aws/foo/bar', { fetchFn })
    await expect(fetch('sha256:x')).rejects.toThrow('HTTP 404')
  })

  it('throws fail-loud on 500', async () => {
    const fetchFn = jest.fn<typeof fetch>().mockResolvedValue(errStatus(500))
    const fetch = createManifestFetcher('public.ecr.aws/foo/bar', { fetchFn })
    await expect(fetch('sha256:x')).rejects.toThrow('HTTP 500')
  })
})
