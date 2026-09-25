# Deployment

The bundle is served by Cloud Run in `zetta-research` / `us-east1`. Vercel still builds
`dev` and `main`, but only so its old hosts redirect to the aliases below.

| Branch | Cloud Run service     | URL                                        |
| ------ | --------------------- | ------------------------------------------ |
| `main` | `neuroglancer`        | https://neuroglancer.research.zetta.ai     |
| `dev`  | `neuroglancer-dev`    | https://neuroglancer-dev.research.zetta.ai |
| any PR | `neuroglancer-pr-<N>` | posted as a PR comment                     |

## How a deploy runs

`.github/workflows/deploy-cloud-run.yml` fires on a push to `dev` or `main`. It reads the
`NEUROGLANCER_*` env vars off the live Cloud Run service, passes each one to
`docker buildx build` as a `--build-arg`, pushes the image to Artifact Registry, and runs
`gcloud run deploy`.

Those env vars are _build_ configuration — nginx never reads them, `rspack.config.js`
bakes them into the bundle. They live on the service so they can be changed with gcloud
or the console instead of a commit, and so previews inherit them. A change only takes
effect on the next deploy.

Current values: `neuroglancer` carries `NEUROGLANCER_ZETTA_BACKEND_URL` and
`NEUROGLANCER_ZETTA_GOOGLE_CLIENT_ID_IAP`; `neuroglancer-dev` and previews carry neither,
which is what the Vercel `dev` environment did.

## PR previews

Add the `deploy-preview` label to a PR, or run the **Deploy preview** workflow on the
branch. A preview is _not_ redeployed on later pushes — re-run the workflow or toggle the
label. Closing the PR deletes the service. Previews seed their config from
`neuroglancer-dev`.

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
gcloud artifacts repositories create neuroglancer \
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

COOP/COEP are commented out in three places that must move together: `nginx.conf`,
`vercel.json`, and the dev server in `build_tools/cli.ts`.
