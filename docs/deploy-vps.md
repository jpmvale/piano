# Publicação na VPS

O piano roda na VPS da Hostinger que já hospeda coda, kindred, gas-individualizado e os outros,
em **https://piano.imp-software.cloud**. A configuração da máquina está no repositório
[`jpmvale/vps-infra`](https://github.com/jpmvale/vps-infra).

## Como funciona

1. Push na `main` → workflow **CI** compila o jogo e a imagem Docker.
2. CI verde e `DEPLOY_ENABLED=true` → workflow **deploy** publica `ghcr.io/jpmvale/piano-web:<sha>`
   e roda `ssh deploy@VPS "piano <sha>"`.
3. Na VPS, o forced command `~/bin/deploy.sh` faz checkout do mesmo commit em `~/apps/piano`,
   puxa a imagem e troca o container `piano-web`. Depois confere a raiz (200) e `/health` (200)
   pela URL pública e, se falhar, volta para a versão anterior sozinho.
4. O Caddy compartilhado (`~/caddy`) encaminha `piano.imp-software.cloud` para `piano-web:8080`
   pela rede `edge` e cuida do HTTPS.

## Primeiro deploy (uma vez só)

1. **DNS** (painel da Hostinger): registro `A` `piano` → `187.77.242.128`, TTL 14400.
2. **vps-infra**: fazer o merge do PR que adiciona o piano ao `Caddyfile` e ao `bin/deploy.sh`,
   e aplicar na VPS:
   ```bash
   # da sua máquina, na pasta do vps-infra
   scp caddy/Caddyfile vps:~/caddy/Caddyfile
   scp bin/deploy.sh vps:~/bin/deploy.sh
   ssh vps 'cd ~/caddy && docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile'
   ```
3. **Clone na VPS** (o repositório é público, então não precisa de deploy key):
   ```bash
   ssh vps 'git clone https://github.com/jpmvale/piano ~/apps/piano'
   ```
4. **Segredos deste repositório** (Settings → Secrets and variables → Actions), com os mesmos
   valores usados no coda: `VPS_HOST` e `VPS_DEPLOY_KEY`.
5. Rodar o workflow **deploy** manualmente (Actions → deploy → Run workflow) e conferir o site.
6. Ligar o automático: variável de repositório `DEPLOY_ENABLED` = `true`.
