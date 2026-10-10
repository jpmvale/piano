# Publicação na VPS

O piano roda na mesma VPS do coda, atrás do Caddy dele (que já ocupa as portas 80 e 443 e cuida do HTTPS).

## Como funciona

1. Push na `main` → workflow **CI** compila o jogo e a imagem Docker.
2. CI verde → workflow **deploy** publica `ghcr.io/jpmvale/piano:<sha>` e `:latest` e roda
   `ssh deploy@VPS "piano <sha>"`.
3. Na VPS, o script de deploy (o mesmo forced command que atende `coda <sha>`) troca só o container `piano`.
4. O Caddy do coda encaminha o subdomínio do piano para o container `piano` (porta 80, nginx servindo o `index.html`).

## Peças fora deste repositório

**Repositório coda** (PR separado): serviço `piano` no `docker-compose.prod.yml` e um bloco
`{$PIANO_ADDRESS}` no `Caddyfile`.

**Segredos deste repositório** (Settings → Secrets and variables → Actions), os mesmos valores do coda:

- `VPS_HOST`
- `VPS_DEPLOY_KEY`

**DNS**: um registro A (ou CNAME) do subdomínio do piano apontando para a VPS.

**Na VPS**:

- No `.env` do coda: `PIANO_ADDRESS=<subdomínio do piano>`.
- No script do forced command, um caso para `piano`. O script real só existe na VPS, então adapte
  os nomes; a ideia é esta:

```bash
# $SSH_ORIGINAL_COMMAND chega como "piano <sha7>"
read -r alvo tag <<< "$SSH_ORIGINAL_COMMAND"
case "$alvo" in
  piano)
    [[ "$tag" =~ ^[0-9a-f]{7}$ ]] || { echo "tag inválida: $tag"; exit 2; }
    cd /caminho/do/coda   # onde ficam os docker-compose do coda
    export PIANO_TAG="$tag"
    docker compose -f docker-compose.yml -f docker-compose.prod.yml pull piano
    docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --no-deps piano
    ;;
  # coda) ... o caso que já existe ...
esac
```

`--no-deps` garante que o deploy do piano não reinicia nada do coda.
