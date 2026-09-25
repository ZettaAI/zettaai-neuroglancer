# syntax=docker/dockerfile:1.7

FROM node:22.18.0-slim AS builder
WORKDIR /app
ENV HUSKY=0

COPY package.json package-lock.json .npmrc ./

RUN --mount=type=secret,id=npm_token \
    printf '//npm.pkg.github.com/:_authToken=%s\n' "$(cat /run/secrets/npm_token)" > /tmp/npmrc \
 && npm ci --ignore-scripts --userconfig=/tmp/npmrc \
 && rm -f /tmp/npmrc

COPY . .

# Every NEUROGLANCER_* env var on the service is forwarded as a --build-arg, and BuildKit
# drops one with no matching ARG silently, so this must cover every zettaDefine() call in
# rspack.config.js.
ARG NEUROGLANCER_ZETTA_BACKEND_URL
ARG NEUROGLANCER_ZETTA_GOOGLE_CLIENT_ID_IAP
ARG NEUROGLANCER_ZETTA_BACKEND_TOKEN

RUN npm run build:zetta -- --no-typecheck --no-lint

# Pre-compressed for `gzip_static` in nginx.conf; the alpine image has no brotli module.
RUN find dist/client -type f \
      \( -name '*.js' -o -name '*.css' -o -name '*.html' -o -name '*.json' \
         -o -name '*.wasm' -o -name '*.svg' \) \
      -exec gzip -9 -k {} +


FROM nginx:1.27-alpine AS runner
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/dist/client /usr/share/nginx/html
EXPOSE 8080
