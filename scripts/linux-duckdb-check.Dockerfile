FROM node:26.13.0-bookworm@sha256:fa52d1669505e29b58c042875b1d65c229e0787a3610fd52869b22b68e480853

WORKDIR /work
COPY package.json package-lock.json .npmrc ./
COPY framework/packages/ ./framework/packages/
RUN npm ci --ignore-scripts

COPY scripts/linux-duckdb-check.mjs ./
COPY test/fixtures/duckdb-v1.5.6-forward-read.duckdb.gz ./
CMD ["node", "linux-duckdb-check.mjs", "duckdb-v1.5.6-forward-read.duckdb.gz"]
