#!/bin/bash

curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.4/install.sh | bash && \
source ~/.bashrc && \
nvm install v22.13.1 && \
corepack enable && \
yarn
