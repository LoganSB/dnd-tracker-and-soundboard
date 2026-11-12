"""gunicorn settings for running the app in a container (used by the Dockerfile: gunicorn -c gunicorn.conf.py app:app).

gunicorn is a production web server for Python. Flask's built-in server (what `python app.py` uses) is for
development only: it is not hardened and handles one slow client badly. gunicorn reads this file, which is
just Python: every top-level variable named like a gunicorn setting configures it.
"""
import os

# Listen on every network interface inside the container, on the port the platform gives us. Cloud Run
# passes the port in the PORT environment variable (8080 by default); 8080 is also our fallback.
bind = f"0.0.0.0:{os.environ.get('PORT', '8080')}"

# ONE worker process, on purpose. The app keeps the soundboard state in memory and in files, protected by a
# lock that only works inside one process. Two worker processes would each hold their own copy of the state
# and overwrite each other's saves. Concurrency comes from threads instead (next setting).
workers = 1

# "gthread" = each worker runs a pool of threads; every request, plus the background media downloads, runs
# on one. 16 threads is plenty for one DM and a few browser tabs, each polling the server every few seconds.
worker_class = "gthread"
threads = 16

# A request that takes longer than this many seconds is killed. Downloads run in background threads, not in
# a request, so the longest real request is an upload of an audio file.
timeout = 120
# On shutdown (a new deployment, scale-to-zero) give running requests this long to finish.
graceful_timeout = 30
# Keep idle browser connections open this long, so the page does not reconnect for every request.
keepalive = 75

# Log requests and errors to the console ("-" = standard output / error). Cloud Run collects both
# into Cloud Logging, where `gcloud run services logs read` shows them.
accesslog = "-"
errorlog = "-"
