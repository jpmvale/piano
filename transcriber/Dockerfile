# Serviço de importação do Piano Cascata: recebe um link do YouTube, baixa o
# áudio com o yt-dlp e transcreve para MIDI com o Transkun, só na CPU.
FROM python:3.12-slim

RUN apt-get update \
	&& apt-get install -y --no-install-recommends ffmpeg \
	&& rm -rf /var/lib/apt/lists/*

WORKDIR /srv

# torch só CPU, do índice do PyTorch: o do PyPI traz CUDA e passa de 4 GB.
RUN pip install --no-cache-dir torch torchaudio --index-url https://download.pytorch.org/whl/cpu
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app app
COPY tests tests

RUN useradd --system --uid 10001 piano && mkdir -p /data && chown piano /data
USER piano

ENV DADOS=/data THREADS=2 PYTHONUNBUFFERED=1
EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=5s --retries=4 \
	CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=4)"
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*"]
