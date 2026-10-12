# Deployment

The bundle is served by Cloud Run in `zetta-research` / `us-east1`.

| Trigger                | Cloud Run service     | URL                                        |
| ---------------------- | --------------------- | ------------------------------------------ |
| push to `main`         | `neuroglancer`        | https://neuroglancer.research.zetta.ai     |
| push to `main`         | `neuroglancer-dev`    | https://neuroglancer-dev.research.zetta.ai |
| `deploy-preview` label | `neuroglancer-pr-<N>` | posted as a PR comment                     |

## How a deploy runs

`.github/workflows/deploy-cloud-run.yml` fires on a push to `main` and deploys every
service `BRANCH_SERVICES` maps the branch to. For each one it reads the
`NEUROGLANCER_*` env vars off the live Cloud Run service, passes each one to
`docker buildx build` as a `--build-arg`, pushes the image to Artifact Registry, and runs
`gcloud run deploy`.

Those env vars are _build_ configuration — nginx never reads them, `rspack.config.js`
bakes them into the bundle. They live on the service so they can be changed with gcloud
or the console instead of a commit, and so previews inherit them. A change only takes
effect on the next deploy.

Current values: `neuroglancer` carries `NEUROGLANCER_ZETTA_BACKEND_URL` and
`NEUROGLANCER_ZETTA_GOOGLE_CLIENT_ID_IAP`; `neuroglancer-dev` and previews carry neither.

## PR previews

Add the `deploy-preview` label to a PR, or run the **Deploy preview** workflow on the
branch. A preview is _not_ redeployed on later pushes — re-run the workflow or toggle the
label. Previews seed their config from `neuroglancer-dev`.

Each preview is recorded as a deployment in the `preview-pr-<N>` GitHub environment,
linking to the service, so live previews appear on the repo's Deployments page and in the
PR timeline. Main deploys run in the `production` (`neuroglancer`) and `development`
(`neuroglancer-dev`) environments.

`preview-teardown.yml` deletes a preview: the service, its image tags, its GitHub
deployments and the `preview-pr-<N>` environment, then removes the `deploy-preview` label.
It runs when the PR is closed, and from `preview-cleanup.yml`, which runs daily over every
`neuroglancer-pr-<N>` service and deletes those whose PR is closed or had no activity for
5 days. Run the cleanup by hand with `pr` set to delete one preview.

The workflow token cannot delete environments, so teardown uses a token from the CI GitHub
App in the `APP_ID` and `APP_PEM` secrets, which needs the Administration (read and write)
repository permission on this repo. Deleting image tags needs
`artifactregistry.tags.delete` for `WIF_SERVICE_ACCOUNT` on the `zettaai-neuroglancer`
repository.

## Testing the image locally

```bash
NPM_TOKEN=<github packages read token> docker buildx build \
  --secret id=npm_token,env=NPM_TOKEN \
  --build-arg NEUROGLANCER_ZETTA_BACKEND_URL=https://zutils-web-api-hhtsusnvoq-ue.a.run.app \
  -t neuroglancer-local .

docker run --rm -p 8080:8080 neuroglancer-local
```

## One-time GCP bootstrap

Needs a project admin. The two long-lived services must exist before the first deploy,
because the workflow reads its build config off them.

```bash
gcloud artifacts repositories create zettaai-neuroglancer \
  --repository-format=docker --location=us-east1 --project=zetta-research

for svc in neuroglancer neuroglancer-dev; do
  gcloud run deploy "$svc" \
    --project=zetta-research --region=us-east1 \
    --image=us-docker.pkg.dev/cloudrun/container/hello \
    --port=8080 --memory=512Mi --cpu=1 --allow-unauthenticated --quiet
done

gcloud run services update neuroglancer \
  --project=zetta-research --region=us-east1 \
  --update-env-vars=^@^NEUROGLANCER_ZETTA_BACKEND_URL=https://zutils-web-api-hhtsusnvoq-ue.a.run.app@NEUROGLANCER_ZETTA_GOOGLE_CLIENT_ID_IAP=349854005841-5tek0v152pbrto7f2ffu9m7pj6hfa7ip.apps.googleusercontent.com
```

Then map `neuroglancer.research.zetta.ai` and `neuroglancer-dev.research.zetta.ai` at the
two services, and add both origins to OAuth client `349854005841-5tek…` as authorized
JavaScript origins plus `<origin>/google_oauth2_redirect.html` redirect URIs — standalone
Google sign-in derives its redirect from the page's own origin.

## Re-enabling cross-origin isolation

COOP/COEP are commented out in two places that must move together: `nginx.conf` and
the dev server in `build_tools/cli.ts`.
