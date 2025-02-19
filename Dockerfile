# syntax=docker/dockerfile:1

# Copyright 2024 Qlever LLC
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

ARG NODE_VER=22-alpine
ARG DIR=/usr/src/app/

FROM node:${NODE_VER} AS base
ARG DIR

# Install needed packages
RUN apk add --no-cache \
  dumb-init

WORKDIR ${DIR}

# Copy in code
COPY . ${DIR}/

RUN corepack yarn workspaces focus --all --production

# Launch entrypoint with dumb-init
# Remap SIGTERM to SIGINT https://github.com/Yelp/dumb-init#signal-rewriting
ENTRYPOINT ["/usr/bin/dumb-init", "--rewrite", "15:2", "--", "corepack", "yarn", "run"]
CMD ["start"]

FROM base AS build
ARG DIR

# Install build-only packages
RUN apk add --no-cache \
  git

# Install dev deps too
RUN corepack yarn install --immutable

# Build code
RUN corepack yarn build --verbose

FROM base AS production
ARG DIR

ENV COREPACK_HOME=/home/node/.cache/node/corepack
RUN corepack enable

# Copy in built code
COPY --from=build ${DIR}/dist ${DIR}/dist

RUN chown -R node:node ${DIR}
# Do not run service as root
USER node

# Have corepack download yarn
RUN corepack install