# Skip Jackson Medicare — website + CRM. Zero npm dependencies.
FROM node:25-slim

ENV NODE_ENV=production \
    PORT=8790 \
    DATA_DIR=/data \
    BACKUP_DIR=/data/backups

WORKDIR /app
COPY package.json ./
COPY server ./server
COPY crm ./crm
COPY public ./public
COPY scripts ./scripts

# Run as an unprivileged user; the database lives on a mounted volume.
RUN groupadd --system app && useradd --system --gid app --home /app --shell /usr/sbin/nologin app \
 && mkdir -p /data && chown app:app /data && chmod 700 /data
USER app

VOLUME ["/data"]
EXPOSE 8790
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8790)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
STOPSIGNAL SIGTERM
CMD ["node", "server/index.js"]
