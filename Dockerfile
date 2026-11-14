# syntax=docker/dockerfile:1
#
# Container image for the DND Tracker (Flask app served by gunicorn). Built for Google Cloud Run but it runs
# anywhere Docker does. See DEPLOY-GOOGLE-CLOUD.md for how to build, upload and start it.
#
# A Dockerfile is a recipe: each instruction adds a "layer" to the image, and Docker re-uses a layer from
# its cache when nothing above it changed. So the instructions are ordered from "changes rarely" (the
# Python install) to "changes often" (our own code), which makes rebuilds fast.

# Base image: Python on a minimal Debian ("slim" leaves out compilers and docs we do not need). Pinning the
# minor version keeps builds repeatable.
FROM python:3.12-slim

# Settings for Python and pip inside the image:
#   PYTHONUNBUFFERED       print log lines immediately instead of holding them in a buffer
#   PYTHONDONTWRITEBYTECODE  do not litter the image with .pyc files
#   PIP_NO_CACHE_DIR       do not keep pip's download cache (smaller image)
#   PORT                   the port gunicorn listens on (Cloud Run overrides it, see gunicorn.conf.py)
#   DND_DATA_ROOT          the folder the app keeps data/, media/ and mp3s/ in. /data is meant to be a
#                          mounted volume (a Cloud Storage bucket on Cloud Run), because the container's own
#                          disk is thrown away whenever the container stops.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PORT=8080 \
    DND_DATA_ROOT=/data

WORKDIR /app

# 1) Install the dependencies first, from requirements.txt alone. This layer is only rebuilt when that
#    file changes, not every time we edit the code.
COPY requirements.txt .
RUN pip install -r requirements.txt

# 2) Copy only what the app needs at run time. (.dockerignore keeps everything else out of the build:
#    your saved data, the Fight Club files, the virtual environment ...)
COPY app.py party.py auth.py encounters.py fcformat.py board.py charcalc.py fcmonster.py savefiles.py uploads.py gunicorn.conf.py ./
COPY templates ./templates
COPY static ./static

# The data folder. When a volume is mounted at /data this is simply hidden behind it.
RUN mkdir -p /data

# NOTE on users: the app runs as root inside the container. Cloud Run's sandbox isolates the container, and a
# Cloud Storage bucket mounted as a volume is not reliably writable by other user ids. To run as an ordinary
# user elsewhere (a VM, Kubernetes), add:  RUN useradd -u 10001 dnd && chown -R dnd /data /app  and  USER dnd

EXPOSE 8080

# Used by plain Docker (Cloud Run ignores it): ask /healthz every 30 seconds whether the app answers.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD python -c "import os,urllib.request; urllib.request.urlopen('http://127.0.0.1:%s/healthz' % os.environ.get('PORT','8080'), timeout=3)" || exit 1

# Start the production server with our settings file; "app:app" = the object named `app` in app.py.
CMD ["gunicorn", "-c", "gunicorn.conf.py", "app:app"]
