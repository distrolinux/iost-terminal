FROM node:24-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force

COPY . .
RUN mkdir -p /app/data

EXPOSE 8787
HEALTHCHECK --interval=10s --timeout=4s --start-period=10s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:8787/api/health',{signal:AbortSignal.timeout(3000)}).then(async r=>{const b=await r.json();if(!r.ok||b.ok!==true)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
