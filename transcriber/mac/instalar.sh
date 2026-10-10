#!/usr/bin/env bash
# Prepara este Mac para transcrever as músicas do Piano Cascata (ver README.md ao lado).
#
#   ./instalar.sh <MAC_TOKEN>            instala e guarda o token
#   ./instalar.sh <MAC_TOKEN> --sempre   idem, e liga sozinho quando você entra no Mac
set -euo pipefail

AQUI="$(cd "$(dirname "$0")" && pwd)"
RAIZ="$(dirname "$AQUI")"                 # pasta transcriber/
CASA="${HOME}/.piano-mac"
TOKEN="${1:-}"
SEMPRE="${2:-}"

[ -n "$TOKEN" ] || { echo "uso: $0 <MAC_TOKEN> [--sempre]"; exit 1; }
command -v ffmpeg >/dev/null || { echo "Falta o ffmpeg. Instale com: brew install ffmpeg"; exit 1; }
PY="$(command -v python3.12 || command -v python3.13 || command -v python3 || true)"
[ -n "$PY" ] || { echo "Falta o Python 3. Instale com: brew install python@3.12"; exit 1; }
"$PY" -c 'import sys; assert sys.version_info >= (3, 10)' 2>/dev/null \
	|| { echo "Precisa de Python 3.10 ou mais novo ($PY é $("$PY" --version))."; exit 1; }

mkdir -p "$CASA"
if [ ! -x "$CASA/venv/bin/python" ]; then
	echo "Criando o ambiente em $CASA/venv…"
	"$PY" -m venv "$CASA/venv"
fi
echo "Instalando o modelo e as dependências (a primeira vez baixa ~1 GB)…"
"$CASA/venv/bin/pip" install -q --upgrade pip
"$CASA/venv/bin/pip" install -q torch torchaudio
"$CASA/venv/bin/pip" install -q -r "$RAIZ/requirements.txt"

umask 077
printf '%s\n' "$TOKEN" > "$CASA/token"
echo "Token guardado em $CASA/token."

if [ "$SEMPRE" = "--sempre" ]; then
	PLIST="${HOME}/Library/LaunchAgents/cloud.imp-software.piano-mac.plist"
	mkdir -p "$(dirname "$PLIST")"
	cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>cloud.imp-software.piano-mac</string>
	<key>ProgramArguments</key><array><string>${AQUI}/rodar.sh</string></array>
	<key>RunAtLoad</key><true/>
	<key>KeepAlive</key><true/>
	<key>ThrottleInterval</key><integer>30</integer>
	<key>StandardOutPath</key><string>${CASA}/mac.log</string>
	<key>StandardErrorPath</key><string>${CASA}/mac.log</string>
	<key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
</dict>
</plist>
PLIST
	launchctl bootout "gui/$(id -u)/cloud.imp-software.piano-mac" 2>/dev/null || true
	launchctl bootstrap "gui/$(id -u)" "$PLIST"
	echo "Ligado: roda sozinho a partir de agora. Log em $CASA/mac.log."
	echo "Para desligar: launchctl bootout gui/$(id -u)/cloud.imp-software.piano-mac && rm $PLIST"
else
	echo "Pronto. Para rodar: $AQUI/rodar.sh"
fi
