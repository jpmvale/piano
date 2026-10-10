# Imagem do Piano Cascata: compila o jogo (um index.html com tudo embutido)
# e serve com nginx. Na VPS ela fica atrás do Caddy do coda, que cuida do HTTPS.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:1.27-alpine
COPY --from=build /app/dist/index.html /usr/share/nginx/html/index.html
EXPOSE 80
