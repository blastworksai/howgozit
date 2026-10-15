# Built and started once on Linux by the authors, never behind a real login proxy; see references/deploy-proxy.md.
# Build context is the src folder (the one holding board/, scripts/ and package.json).
FROM node:22-alpine

# The server has no dependencies, so there is no npm install.
WORKDIR /app
COPY package.json LICENSE ./
COPY board ./board
COPY scripts ./scripts

# A user with no shell and no rights; /data is the only place it may write.
RUN addgroup -S board && adduser -S -G board -H -s /sbin/nologin board \
 && mkdir -p /data && chown board:board /data

ENV BOARD_MODE=proxy \
    BOARD_HOST=0.0.0.0 \
    BOARD_DATA_DIR=/data

USER board
VOLUME /data
EXPOSE 8787

# /healthz needs no identity header and answers whatever the Host. Node's own fetch, no curl.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8787/healthz').then(r=>r.text()).then(t=>process.exit(t==='ok'?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "board/server.mjs"]
