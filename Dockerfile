# Image de production de l'API PrismaSoft.Compta (maxicompta_api).
# Build TypeScript (tsc → dist/) puis exécution en Node prod.
# Écoute sur le port 3000 — attendu par traefik (loadbalancer.server.port=3000).

# ---- Étape build : compilation TypeScript ----
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- Étape runtime : dépendances de prod uniquement ----
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# Dossier des chaînes de connexion chiffrées (data/connections.enc.json).
# Monté en volume en prod pour survivre aux rebuilds — voir DEPLOY-SERVEUR.md.
RUN mkdir -p /app/data
EXPOSE 3000
CMD ["node", "dist/index.js"]
