FROM node:14-alpine as build

ARG TARGETPLATFORM

WORKDIR /app

# install dependencies
COPY package.json .
COPY package-lock.json .
RUN npm ci

# build source code
COPY tsconfig.json .
COPY tsconfig.build.json .
COPY src src
RUN node_modules/.bin/tsc -b tsconfig.build.json
RUN export ARCH=$(echo $TARGETPLATFORM | cut -c7-11)
RUN node_modules/.bin/pkg . --targets node14-alpine-$ARCH --no-bytecode

######################################
FROM docker:20.10.6-dind

WORKDIR /app
COPY --from=build /app/hammerkit /usr/local/bin/hammerkit

ENTRYPOINT ["hammerkit"]
