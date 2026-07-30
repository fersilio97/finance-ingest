# Build context is the repo root (see docker-compose.yml). The container
# mirrors the repo layout exactly (/srv/backend, /srv/frontend, /srv/data)
# so the app's relative path resolution (REPO_ROOT = parents[N]) behaves
# identically in Docker and in local dev.
FROM python:3.12-slim

WORKDIR /srv

COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt

COPY backend backend
COPY frontend frontend

WORKDIR /srv/backend
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
