import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ImageDetail } from '@aws-sdk/client-ecr-public'
import { planCleanup, type ManifestFetcher } from '../src/cleanup.js'

const here = path.dirname(fileURLToPath(import.meta.url))

interface Fixture {
  images: ImageDetail[]
  manifests: Record<string, string[]>
}

function loadFixture(name: string): Fixture {
  const p = path.join(here, '..', '__fixtures__', `${name}.json`)
  return JSON.parse(readFileSync(p, 'utf8'))
}

function fetcherFrom(manifests: Record<string, string[]>): ManifestFetcher {
  return async (digest) => manifests[digest] ?? []
}

describe('planCleanup', () => {
  it('keeps manifest-list children and deletes an unrelated orphan', async () => {
    const fx = loadFixture('manifest-list-with-children')
    const plan = await planCleanup(fx.images, fetcherFrom(fx.manifests))

    expect(plan.toKeep.sort()).toEqual(
      [
        'sha256:amd64childaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'sha256:arm64childbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
      ].sort()
    )
    expect(plan.toDelete).toEqual([
      'sha256:orphancccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
    ])
  })

  it('tagged single-arch manifest: deletes orphan only, keeps nothing', async () => {
    const fx = loadFixture('single-arch-tagged')
    const plan = await planCleanup(fx.images, fetcherFrom(fx.manifests))

    expect(plan.toDelete).toEqual([
      'sha256:orphancccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
    ])
    expect(plan.toKeep).toEqual([])
  })

  it('empty repo: no-op', async () => {
    const fx = loadFixture('empty')
    const plan = await planCleanup(fx.images, fetcherFrom(fx.manifests))

    expect(plan.toDelete).toEqual([])
    expect(plan.toKeep).toEqual([])
  })

  it('propagates fetcher errors (fail loud instead of treating list as childless)', async () => {
    const images: ImageDetail[] = [
      { imageDigest: 'sha256:parent', imageTags: ['v1'] },
      { imageDigest: 'sha256:orphan', imageTags: [] }
    ]
    const fetcher: ManifestFetcher = async () => {
      throw new Error('registry 500')
    }

    await expect(planCleanup(images, fetcher)).rejects.toThrow('registry 500')
  })

  it('skips entries with no imageDigest', async () => {
    const images: ImageDetail[] = [
      { imageDigest: undefined, imageTags: ['v1'] },
      { imageDigest: 'sha256:orphan', imageTags: [] }
    ]
    const plan = await planCleanup(images, async () => [])

    expect(plan.toDelete).toEqual(['sha256:orphan'])
    expect(plan.toKeep).toEqual([])
  })
})
