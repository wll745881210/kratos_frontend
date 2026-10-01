# kratos-frontend: all-in-one image (REST server + built web client).
#
# The kratos binary itself is NOT containerized here (it needs a CUDA/HIP
# toolchain and a GPU); this image serves the Spec/par toolchain, previews,
# and the web UI.
#
# Build:  docker build -t kratos-frontend .
#         (registry mirror needed? override bases:
#          docker build --build-arg NODE_IMAGE=mirror.example.com/library/node:22-slim \
#                       --build-arg PY_IMAGE=mirror.example.com/library/python:3.12-slim ...)
# Run:    docker run -p 8620:8620 -v /path/to/projects:/data kratos-frontend
# Then:   http://localhost:8620/  (UI)  or  /docs (OpenAPI)

ARG NODE_IMAGE=node:22-slim
ARG PY_IMAGE=python:3.12-slim

# ---- stage 1: build the web client -------------------------------------
FROM ${NODE_IMAGE} AS client
WORKDIR /app/web/client
COPY web/client/package.json web/client/package-lock.json ./
RUN npm ci
COPY web/client/ ./
RUN npm run build

# ---- stage 2: python server --------------------------------------------
FROM ${PY_IMAGE}
WORKDIR /app

COPY pyproject.toml ./
COPY core/ core/
COPY web/server/ web/server/
COPY descriptors/ descriptors/
COPY --from=client /app/web/client/dist web/client/dist

RUN pip install --no-cache-dir '.[server]'

# Mount your project/par directories at /data (whitelisted FS root).
VOLUME ["/data"]
ENV KRATOS_FRONT_ROOTS=/data \
    KRATOS_FRONT_DESCRIPTORS=/app/descriptors \
    KRATOS_FRONT_DIST=/app/web/client/dist

EXPOSE 8620
CMD ["kratos-front", "serve", "--host", "0.0.0.0", "--port", "8620"]
