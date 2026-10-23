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
# A pasta `dist` INTEIRA: desde 23/10/2026 o build da web emite JS, CSS e as
# amostras como arquivos separados, para a CSP poder recusar script embutido.
# Os timbres de `public/timbres` já vinham por aqui — a cópia separada deles
# virou redundante e saiu.
COPY --from=build /app/dist/ /usr/share/nginx/html/
EXPOSE 8080
