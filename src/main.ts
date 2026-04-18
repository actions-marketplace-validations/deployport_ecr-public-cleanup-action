import * as core from '@actions/core'
import { ECRPUBLICClient } from '@aws-sdk/client-ecr-public'
import { planCleanup } from './cleanup.js'
import { deleteImages, getRegistryUri, listAllImages } from './ecr.js'
import { createManifestFetcher } from './manifest.js'

export async function run(): Promise<void> {
  try {
    const repository = core.getInput('repository', { required: true })
    const dryRun = core.getBooleanInput('dry-run')

    const client = new ECRPUBLICClient({ region: 'us-east-1' })

    const registryUri = await getRegistryUri(client)
    const imageUri = `${registryUri}/${repository}`
    core.info(`Registry: ${registryUri}`)

    core.info(`Listing images in ${repository}...`)
    const images = await listAllImages(client, repository)
    core.info(`Found ${images.length} images`)

    const fetcher = createManifestFetcher(imageUri)

    const { toDelete, toKeep } = await planCleanup(images, fetcher)

    core.info(
      `Plan: delete ${toDelete.length} untagged/unreferenced, keep ${toKeep.length} untagged-but-referenced`
    )
    for (const d of toDelete) core.info(`  delete ${d}`)
    for (const d of toKeep) core.info(`  keep   ${d} (manifest-list child)`)

    if (dryRun) {
      core.info('Dry run: skipping batch-delete-image')
      core.setOutput('deleted-count', 0)
    } else if (toDelete.length === 0) {
      core.info('Nothing to delete')
      core.setOutput('deleted-count', 0)
    } else {
      core.info(`Deleting ${toDelete.length} images...`)
      await deleteImages(client, repository, toDelete)
      core.setOutput('deleted-count', toDelete.length)
    }

    core.setOutput('kept-count', toKeep.length)
    core.setOutput('deleted-digests', toDelete.join('\n'))
  } catch (err) {
    core.setFailed(err instanceof Error ? err.message : String(err))
  }
}
