import { URL } from 'url'

const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json'
].join(', ')

const DEFAULT_MAX_RETRIES = 3
const DEFAULT_BASE_RETRY_DELAY_MS = 1000

interface ManifestResponse {
  manifests?: Array<{ digest: string }>
}

export interface BearerChallenge {
  realm: string
  service?: string
  scope?: string
}

export interface ManifestFetcherOptions {
  fetchFn?: typeof fetch
  sleepFn?: (ms: number) => Promise<void>
  maxRetries?: number
}

export function buildManifestUrl(imageUri: string, digest: string): string {
  const clean = imageUri.replace(/^https?:\/\//, '')
  const slash = clean.indexOf('/')
  if (slash < 0) {
    throw new Error(
      `image-uri must be of the form host/repo-path, got: ${imageUri}`
    )
  }
  const host = clean.slice(0, slash)
  const path = clean.slice(slash + 1)
  return `https://${host}/v2/${path}/manifests/${digest}`
}

export function parseBearerChallenge(header: string): BearerChallenge | null {
  const m = /^\s*Bearer\s+(.+)$/i.exec(header)
  if (!m) return null
  const params: Record<string, string> = {}
  const re = /([a-zA-Z_]+)="([^"]*)"/g
  let p: RegExpExecArray | null
  while ((p = re.exec(m[1])) !== null) {
    params[p[1]] = p[2]
  }
  if (!params.realm) return null
  return {
    realm: params.realm,
    service: params.service,
    scope: params.scope
  }
}

export function parseRetryAfter(header: string | null): number | null {
  if (!header) return null
  const trimmed = header.trim()
  if (/^\d+$/.test(trimmed)) {
    return parseInt(trimmed, 10) * 1000
  }
  const date = Date.parse(trimmed)
  if (!isNaN(date)) return Math.max(0, date - Date.now())
  return null
}

export function createManifestFetcher(
  imageUri: string,
  opts: ManifestFetcherOptions = {}
): (digest: string) => Promise<string[]> {
  const fetchFn = opts.fetchFn ?? fetch
  const sleepFn =
    opts.sleepFn ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES

  let cachedToken: string | null = null

  async function fetchWithRetry(
    url: string,
    init: RequestInit
  ): Promise<Response> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const res = await fetchFn(url, init)
      if (res.status !== 429) return res
      if (attempt === maxRetries) return res
      const delayMs =
        parseRetryAfter(res.headers.get('retry-after')) ??
        DEFAULT_BASE_RETRY_DELAY_MS * (attempt + 1)
      await sleepFn(delayMs)
    }
    /* istanbul ignore next */
    throw new Error('fetchWithRetry: loop exited unexpectedly')
  }

  async function fetchToken(challenge: BearerChallenge): Promise<string> {
    const url = new URL(challenge.realm)
    if (challenge.service) url.searchParams.set('service', challenge.service)
    if (challenge.scope) url.searchParams.set('scope', challenge.scope)
    const res = await fetchWithRetry(url.toString(), {})
    if (!res.ok) {
      throw new Error(`token fetch failed: HTTP ${res.status}`)
    }
    const body = (await res.json()) as { token?: string; access_token?: string }
    const token = body.token ?? body.access_token
    if (!token) {
      throw new Error('token response missing token/access_token field')
    }
    return token
  }

  async function doManifestRequest(digest: string): Promise<Response> {
    const url = buildManifestUrl(imageUri, digest)
    const headers: Record<string, string> = { Accept: MANIFEST_ACCEPT }
    if (cachedToken) headers.Authorization = `Bearer ${cachedToken}`
    return await fetchWithRetry(url, { headers })
  }

  return async function fetchChildren(digest: string): Promise<string[]> {
    let res = await doManifestRequest(digest)

    if (res.status === 401) {
      const authHeader = res.headers.get('www-authenticate')
      if (!authHeader) {
        throw new Error(
          `manifest fetch for ${digest} returned 401 without WWW-Authenticate header`
        )
      }
      const challenge = parseBearerChallenge(authHeader)
      if (!challenge) {
        throw new Error(
          `manifest fetch for ${digest} returned 401 with unsupported auth challenge: ${authHeader}`
        )
      }
      cachedToken = await fetchToken(challenge)
      res = await doManifestRequest(digest)
    }

    if (!res.ok) {
      throw new Error(`manifest fetch for ${digest} failed: HTTP ${res.status}`)
    }
    const body = (await res.json()) as ManifestResponse
    return body.manifests?.map((m) => m.digest) ?? []
  }
}
