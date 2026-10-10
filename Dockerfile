# Imagem do Piano Cascata: compila o jogo (um index.html com tudo embutido) e
# serve com nginx. Na VPS fica atrás do Caddy compartilhado (repo vps-infra).
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist/index.html /usr/share/nginx/html/index.html
EXPOSE 8080
