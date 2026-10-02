FROM node:24-alpine AS build

WORKDIR /app

# install dependencies
COPY package.json .
COPY package-lock.json .
RUN npm ci

# build source code
COPY tsconfig.json .
COPY src src
RUN node_modules/.bin/tsc -b
# every platform builds on a native runner, so pkg's default (the build
# machine's architecture) is the target architecture
RUN node_modules/.bin/pkg . --targets node24-alpine --compress Brotli

######################################
# Minimal runtime: hammerkit talks to the daemon via dockerode and to k8s via
# @kubernetes/client-node — both bundled into the binary — so it needs only a
# shell, CA certs and libstdc++ (for the embedded node), not the full
# docker-cli image with buildx/compose. docker-cli is kept for users who exec
# into the image. Cuts the image roughly in half vs docker:*-cli-alpine.
FROM alpine:3.21

RUN apk add --no-cache docker-cli ca-certificates libstdc++

WORKDIR /app
COPY --from=build /app/hammerkit /usr/local/bin/hammerkit

ENTRYPOINT ["hammerkit"]
