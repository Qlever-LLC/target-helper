#! /bin/bash

SERVICE_ROOT="/code/target-helper"

cd ${SERVICE_ROOT}

if [ -z ${DEBUG+x} ]; then export DEBUG="*"; fi

if [[ ! -d "node_modules" ]]; then
  echo "${SERVICE_ROOT}: yarn install"
  yarn install
fi

echo "npm run start"
npm run start

