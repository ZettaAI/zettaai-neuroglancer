# syntax=docker/dockerfile:1.7

FROM node:22.18.0-slim AS builder
WORKDIR /app
ENV HUSKY=0

COPY package.json package-lock.json .npmrc ./

# --ignore-scripts mirrors CI: it skips the Playwright browser download, which
# the production bundle does not need.
RUN --mount=type=secret,id=npm_token \
    printf '//npm.pkg.github.com/:_authToken=%s\n' "$(cat /run/secrets/npm_token)" > /tmp/npmrc \
 && npm ci --ignore-scripts --userconfig=/tmp/npmrc \
 && rm -f /tmp/npmrc

COPY . .

# Read by `zettaDefine()` in rspack.config.js and baked into the bundle.
ARG NEUROGLANCER_ZETTA_BACKEND_URL
ARG NEUROGLANCER_ZETTA_GOOGLE_CLIENT_ID_IAP

# Lint and typecheck already gate the PR; repeating them here only slows deploys.
RUN npm run build:zetta -- --no-typecheck --no-lint

# Pre-compress for `gzip_static`: nginx:alpine has no brotli module, so gzip -9
# ahead of time is the closest we get to Vercel's brotli.
RUN find dist/client -type f \
      \( -name '*.js' -o -name '*.css' -o -name '*.html' -o -name '*.json' \
         -o -name '*.wasm' -o -name '*.svg' \) \
      -exec gzip -9 -k {} +


FROM nginx:1.27-alpine AS runner
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/dist/client /usr/share/nginx/html
EXPOSE 8080
