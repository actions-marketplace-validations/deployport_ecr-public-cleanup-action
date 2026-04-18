# ECR Public Cleanup

[![Marketplace](https://img.shields.io/github/v/release/deployport/ecr-public-cleanup-action?label=marketplace&logo=github)](https://github.com/marketplace/actions/ecr-public-cleanup)
[![CI](https://github.com/deployport/ecr-public-cleanup-action/actions/workflows/ci.yml/badge.svg)](https://github.com/deployport/ecr-public-cleanup-action/actions/workflows/ci.yml)

Publish images to ECR Public? AWS doesn't support lifecycle policies there, and
they're not going to fix that for you. Go vibe-code your own cleanup script that
works great. We dare you. Ours ate our multi-arch manifests.

**Just use this shit.** It deletes orphan untagged images without breaking your
multi-arch tags.

## Why this exists

We vibe-coded a quick cleanup script for our ECR Public repo and wired it up as
a nightly cron in GitHub Actions. We thought it worked great. It did, right up
until it started quietly deleting the per-architecture manifests our tagged
multi-arch images still pointed at. One morning Graviton pulls were busted.
Rolling that back was not a good afternoon.

Here's the trap: a multi-arch manifest list has per-arch children that carry no
tags of their own. Your naive script sees "untagged" and reaches for the delete
button. Congrats, you just nuked arm64.

AWS never shipped lifecycle policies for ECR Public. No `batch-get-image`
either. You're on your own out here.

So we rewrote it to think before it deletes. It walks every tagged manifest
list, keeps the children, and fails loud on errors instead of deleting in the
dark. The regression test for our own outage lives in this repo.

**Still writing your own cleanup script? Good luck.** AWS isn't going to fix
their shit, and yours will bite you eventually. Save yourself the afternoon.

## Usage

```yaml
name: ECR Cleanup

on:
  schedule:
    - cron: '15 0 * * *'
  workflow_dispatch:

permissions:
  id-token: write
  contents: read

jobs:
  cleanup:
    runs-on: ubuntu-24.04
    steps:
      - uses: aws-actions/configure-aws-credentials@v6
        with:
          role-to-assume: ${{ vars.AWS_ECR_ROLE_ARN }}
          aws-region: us-east-1

      - uses: deployport/ecr-public-cleanup-action@v1
        with:
          repository: gatun/agent
```

## Inputs

| Input        | Required | Default | Description                                                                |
| ------------ | -------- | ------- | -------------------------------------------------------------------------- |
| `repository` | yes      |         | ECR Public repository name (e.g. `gatun/agent`).                           |
| `dry-run`    | no       | `false` | If `true`, log what would be deleted but do not call `batch-delete-image`. |

ECR Public only operates in `us-east-1`; the region is hard-coded. The registry
alias is looked up at runtime via `DescribeRegistries`, so you don't need to
pass the full image URI.

## Outputs

| Output            | Description                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------- |
| `deleted-count`   | Number of digests deleted (`0` when `dry-run: true`).                                       |
| `kept-count`      | Number of untagged digests preserved because they are referenced by a tagged manifest list. |
| `deleted-digests` | Newline-separated list of deleted (or would-be-deleted, in dry-run) digests.                |

## Required IAM permissions

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ecr-public:DescribeRegistries",
        "ecr-public:DescribeImages",
        "ecr-public:BatchDeleteImage"
      ],
      "Resource": "arn:aws:ecr-public::<account-id>:repository/<repository>"
    }
  ]
}
```

If you use OIDC (recommended), the role's trust policy must allow
`sts:AssumeRoleWithWebIdentity` from GitHub's OIDC provider. The action does
**not** need `ecr-public:GetAuthorizationToken` (manifests are read anonymously)
or `ecr-public:GetRegistryCatalogData`.

## Dry run

To preview deletions without touching the registry:

```yaml
- uses: deployport/ecr-public-cleanup-action@v1
  with:
    repository: gatun/agent
    dry-run: true
```

The action logs every planned deletion and populates `deleted-digests` so you
can assert against it in CI before switching to a live run.

## License

MIT. See [LICENSE](./LICENSE).
