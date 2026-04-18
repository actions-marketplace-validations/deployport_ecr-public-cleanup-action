import {
  BatchDeleteImageCommand,
  DescribeRegistriesCommand,
  paginateDescribeImages,
  type ECRPUBLICClient,
  type ImageDetail,
  type ImageIdentifier
} from '@aws-sdk/client-ecr-public'

const BATCH_DELETE_LIMIT = 100

export async function getRegistryUri(client: ECRPUBLICClient): Promise<string> {
  const res = await client.send(new DescribeRegistriesCommand({}))
  const uri = res.registries?.[0]?.registryUri
  if (!uri) {
    throw new Error(
      'ECR Public DescribeRegistries returned no registry with a usable registryUri'
    )
  }
  return uri
}

export async function listAllImages(
  client: ECRPUBLICClient,
  repositoryName: string
): Promise<ImageDetail[]> {
  const out: ImageDetail[] = []
  for await (const page of paginateDescribeImages(
    { client },
    { repositoryName }
  )) {
    if (page.imageDetails) out.push(...page.imageDetails)
  }
  return out
}

export async function deleteImages(
  client: ECRPUBLICClient,
  repositoryName: string,
  digests: string[]
): Promise<void> {
  for (let i = 0; i < digests.length; i += BATCH_DELETE_LIMIT) {
    const chunk = digests.slice(i, i + BATCH_DELETE_LIMIT)
    const imageIds: ImageIdentifier[] = chunk.map((d) => ({ imageDigest: d }))
    await client.send(new BatchDeleteImageCommand({ repositoryName, imageIds }))
  }
}
