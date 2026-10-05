# The registry's own reference node: the Python Node Kit in front of an Ollama engine.
FROM python:3.12-slim
RUN apt-get update -qq && apt-get install -y -qq curl >/dev/null && pip install --no-cache-dir "onp-node==0.1.4" && rm -rf /var/lib/apt/lists/*
WORKDIR /data
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 8800
ENTRYPOINT ["/entrypoint.sh"]
