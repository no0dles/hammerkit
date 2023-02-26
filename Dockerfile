FROM node:18-alpine as build

ARG TARGETPLATFORM

WORKDIR /app

# install dependencies
COPY package.json .
COPY package-lock.json .
RUN npm ci

# build source code
COPY tsconfig.json .
COPY src src
RUN node_modules/.bin/tsc -b
RUN export ARCH=$(echo $TARGETPLATFORM | cut -c7-11)
RUN node_modules/.bin/pkg . --targets "node16-alpine-$ARCH" --compress Brotli

######################################
FROM docker:23.0.1-cli-alpine3.17

WORKDIR /app
COPY --from=build /app/hammerkit /usr/local/bin/hammerkit

ENTRYPOINT ["hammerkit"]
