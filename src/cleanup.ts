import type { ImageDetail } from '@aws-sdk/client-ecr-public'

export type ManifestFetcher = (digest: string) => Promise<string[]>

export interface CleanupPlan {
  toDelete: string[]
  toKeep: string[]
}

export async function planCleanup(
  images: ImageDetail[],
  fetchChildren: ManifestFetcher
): Promise<CleanupPlan> {
  const tagged: string[] = []
  const untagged: string[] = []

  for (const img of images) {
    if (!img.imageDigest) continue
    if ((img.imageTags ?? []).length > 0) {
      tagged.push(img.imageDigest)
    } else {
      untagged.push(img.imageDigest)
    }
  }

  const referenced = new Set<string>()
  for (const digest of tagged) {
    const children = await fetchChildren(digest)
    for (const c of children) referenced.add(c)
  }

  const toDelete: string[] = []
  const toKeep: string[] = []
  for (const d of untagged) {
    if (referenced.has(d)) toKeep.push(d)
    else toDelete.push(d)
  }

  return { toDelete, toKeep }
}
