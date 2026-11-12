# Put DND Tracker on Google Cloud

You will end up with the app running at a web address like `https://dnd-tracker-abc123-uc.a.run.app`, protected by a
password, with all your data (soundboard, campaign, characters, audio) stored in a Google Cloud Storage bucket so it
survives restarts and updates. It runs on **Cloud Run**, which runs your container only while someone is using it.

> **Not run end to end.** The app, the production server and the password were tested on a laptop. The container
> build and the Google commands below were not run (no Docker or `gcloud` on that machine). If a step fails, read the
> error and see "If something goes wrong" at the end.

Just want it on your own computer? You do not need any of this:

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python app.py
```

Then open http://127.0.0.1:5000.

## Before you start

You need a Google Cloud project with billing turned on: [console.cloud.google.com](https://console.cloud.google.com).

## Step 1: Get your code into a terminal that has `gcloud`

Google builds the container from the code in your terminal's current folder, so the code has to be there before
anything else. Pick one option.

**Option 1: Cloud Shell (no install).** In the Google Cloud console, click the `>_` icon at the top right. Cloud
Shell is a separate computer in Google's cloud, so it does not have your files yet. Put the code there:

a. On your own computer, in a terminal in the project folder, make a zip that leaves out your data and personal
   files (the data goes in through the bucket in step 4 instead):
   ```bash
   zip -r dnd-code.zip . -x ".venv/*" "data/*" "media/*" "mp3s/*" "FightClub5*" "*.zip" "*.backup" ".git/*" ".DS_Store"
   ```
b. In Cloud Shell, click the three-dot menu (top right of the Cloud Shell window), choose **Upload**, and pick
   `dnd-code.zip`.
c. In Cloud Shell, unpack it into a new folder, go into it, and list it:
   ```bash
   mkdir -p ~/dnd && unzip -o ~/dnd-code.zip -d ~/dnd && cd ~/dnd && ls -a
   ```
   The listing must include `Dockerfile`, `app.py`, `party.py`, `gunicorn.conf.py`, `requirements.txt`, `static`,
   `templates` and `.gcloudignore`. If anything is missing, redo a to c.

Every later command in this guide runs in that Cloud Shell terminal, in `~/dnd`. If Cloud Shell reconnects after
sitting idle, run `cd ~/dnd` and paste the step 2 block again.

**Option 2: your own computer.** Install `gcloud` ([instructions](https://cloud.google.com/sdk/docs/install)),
run `gcloud auth login`, and open a terminal in the project folder.

## Step 2: Choose names

Edit the first line, then paste the block. Leave the rest.

```bash
export PROJECT_ID=your-project-id
export REGION=us-central1
export SERVICE=dnd-tracker
export BUCKET=${PROJECT_ID}-dnd-data
export SA=dnd-run@${PROJECT_ID}.iam.gserviceaccount.com
gcloud config set project $PROJECT_ID
```

(These variables only last for this terminal window. If you close it, paste this block again.)

## Step 3: Switch on the Google services

```bash
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  secretmanager.googleapis.com storage.googleapis.com
```

## Step 4: Create the bucket that holds your data

Versioning keeps older copies of every file, so a mistake can be rolled back.

```bash
gcloud storage buckets create gs://$BUCKET --location=$REGION --uniform-bucket-level-access
gcloud storage buckets update gs://$BUCKET --versioning
```

**Already have data on your computer?** Copy it in now, before the first deploy (the app reads its data when it
starts). Skip this for a fresh start. The bucket's top-level folders must be named `data`, `media` and `mp3s`
(the folders from your project folder, uploaded as they are).

- **If you are using Cloud Shell (option 1), upload in the browser.** The `rsync` commands below would fail there
  with "Did not find existing container", because your data is on your computer, not in Cloud Shell. Instead:
  open [console.cloud.google.com/storage/browser](https://console.cloud.google.com/storage/browser), click your
  bucket (the name is `$BUCKET`; print it with `echo $BUCKET`), click **Upload > Upload folder**, and choose
  `data`, then repeat for `mp3s` and `media`. Check the bucket now lists those folders.
- **If you are on your own computer (option 2), run this in the project folder:**

```bash
gcloud storage rsync --recursive data  gs://$BUCKET/data
gcloud storage rsync --recursive mp3s  gs://$BUCKET/mp3s
gcloud storage rsync --recursive media gs://$BUCKET/media
```

(`media` is your downloaded YouTube and MyInstants audio. Copy it: YouTube often refuses downloads from Google
Cloud, so audio you already have is the reliable way to get it there.)

## Step 5: Create the identity the app runs as

A service account is a login for a program. This one may use the bucket and nothing else.

```bash
gcloud iam service-accounts create dnd-run --display-name="DND Tracker"
gcloud storage buckets add-iam-policy-binding gs://$BUCKET \
  --member=serviceAccount:$SA --role=roles/storage.objectUser
```

## Step 6: Store the site password

The app has no user accounts: one shared password protects everything. It is kept in **Secret Manager**, Google's
built-in secret store, and only the service account above can read it.

Pick **one** of these:

```bash
# A: a password you choose (typed invisibly, never shown or saved in your shell history)
read -rs -p "Site password: " DND_PW && echo
printf '%s' "$DND_PW" | gcloud secrets create dnd-password --data-file=-
unset DND_PW
```

```bash
# B: a random password (read it back whenever you need it with the second command)
openssl rand -base64 18 | gcloud secrets create dnd-password --data-file=-
gcloud secrets versions access latest --secret=dnd-password
```

Then allow the app to read it:

```bash
gcloud secrets add-iam-policy-binding dnd-password \
  --member=serviceAccount:$SA --role=roles/secretmanager.secretAccessor
```

## Step 7: Build and start it

**Build permissions (once).** Newer Google Cloud projects do not let the default build account read your uploaded
code, which makes the deploy fail with a 403. Grant it access:

```bash
export PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)')
export BUILD_SA=${PROJECT_NUMBER}-compute@developer.gserviceaccount.com
gcloud projects add-iam-policy-binding $PROJECT_ID --member=serviceAccount:$BUILD_SA --role=roles/cloudbuild.builds.builder
gcloud projects add-iam-policy-binding $PROJECT_ID --member=serviceAccount:$BUILD_SA --role=roles/storage.objectViewer
```

**Deploy.** From the folder holding your code (`~/dnd` in Cloud Shell; `ls` must show `Dockerfile` and `app.py`),
run the command below. It uploads your code, builds the container in Google's cloud, and starts it. The first time,
gcloud may ask to create an Artifact Registry repository for the image: answer `Y`. It takes a few minutes. The
`.gcloudignore` file keeps your data and personal files out of the upload.

```bash
gcloud run deploy $SERVICE \
  --source . \
  --region $REGION \
  --service-account $SA \
  --execution-environment gen2 \
  --port 8080 \
  --cpu 1 --memory 1Gi \
  --min-instances 0 --max-instances 1 \
  --no-cpu-throttling \
  --allow-unauthenticated \
  --add-volume name=dnd-data,type=cloud-storage,bucket=$BUCKET \
  --add-volume-mount volume=dnd-data,mount-path=/data \
  --set-secrets DND_PASSWORD=dnd-password:latest
```

What the less obvious options do:

| Option | Why |
|---|---|
| `--max-instances 1` | The app keeps your soundboard in memory. A second copy would overwrite the first one's saves. Do not raise this. |
| `--no-cpu-throttling` | Downloads and the MP3-folder watcher run in the background. Without this Cloud Run freezes them between requests. |
| `--add-volume` / `--add-volume-mount` | Mount the bucket at `/data`, where the app saves everything. Without it, data is lost when the container stops. |
| `--allow-unauthenticated` | Lets your browser reach the page. The password from step 6 is what keeps others out. |
| `--min-instances 0` | Costs nothing while nobody uses it; the first visit after a quiet spell takes a few seconds to start. |

When it finishes it prints the service URL. To print it again:

```bash
gcloud run services describe $SERVICE --region $REGION --format='value(status.url)'
```

## Step 8: Open it

Open the URL. The browser asks for a login: type any user name and the password from step 6. Click once on the
page before using sounds (browsers require that click before they allow audio).

Check that it saves: change something, then run

```bash
gcloud storage ls gs://$BUCKET/data/
```

You should see `live.json` listed. If the page does not load, read the log:

```bash
gcloud run services logs read $SERVICE --region $REGION --limit 50
```

## Everyday tasks

| I want to | Do this |
|---|---|
| **Update the app** after changing the code | Zip and upload the code again (step 1, option 1, a to c), then run the step 7 deploy command again. Your data is not touched. |
| **Back up** my data | `gcloud storage rsync --recursive gs://$BUCKET ./dnd-backup` |
| **Restore** a backup | `gcloud storage rsync --recursive ./dnd-backup gs://$BUCKET`, then run the step 7 deploy command again so the app reloads it. |
| **Change the password** | Repeat the step 6 command with `versions add dnd-password` instead of `create dnd-password`, then run the step 7 deploy command again. |
| **Undo a bad save** | The bucket keeps old versions: `gcloud storage ls --all-versions gs://$BUCKET/data/live.json`. The app's own "Presets & versions" dialog also still works. |
| **Keep it always running** | Add `--min-instances 1` to the step 7 deploy command (a small constant cost, no start-up wait). |

To remove everything:

```bash
gcloud run services delete $SERVICE --region $REGION
gcloud storage rm --recursive gs://$BUCKET
gcloud secrets delete dnd-password
gcloud iam service-accounts delete $SA
```

(This does not remove the container image Cloud Build stored; delete the `cloud-run-source-deploy` repository on
the Artifact Registry page of the console if you want that gone too.)

## Limits to know about

- **YouTube may refuse downloads from Google Cloud.** If adding a YouTube link in the cloud copy fails with a
  "sign in" or "bot" message, download the audio by running the app on your own computer and copy the `media`
  folder up (step 4), or upload an MP3 with **Browse** in the sound dialog. MyInstants and direct audio links work.
- **One shared password.** Anyone who has it has full access, and anyone can try to guess it, so make it long
  and random (option B). For stricter access, leave out `--allow-unauthenticated` and open the site with
  `gcloud run services proxy $SERVICE --region $REGION` (a private link on your computer, using your Google login).
- **The bucket is a network disk,** so file access is a little slower than a local disk. A long soundtrack may
  hesitate the first time it plays.
- **The Fight Club expansion download** (`/download/collection.zip`) is deliberately not in the image (it is
  123 MB); that one link says "not found" in the cloud copy.
- **Cost.** With `--min-instances 0` you pay only while a container is running (it stops about 15 minutes after
  the last request) plus pennies a month for bucket storage. Cloud Run's free tier usually covers a game night;
  check Google's pricing page, as prices change.

## If something goes wrong

| What you see | Likely cause and fix |
|---|---|
| The deploy asks to enable an API or create a repository | Answer `Y`. |
| Deploy fails with `403 ... does not have storage.objects.get access` on a `run-sources-...` bucket, or another build permission error | Cloud Build runs as the project's default compute service account, which newer projects do not let build. Run the two commands under "Build permissions" in step 7, wait a minute, then repeat the deploy. |
| Build log says "Python - Runtime Using Runner" or "provide a main.py or app.py" | The deploy ran in the wrong folder, so your code (and `Dockerfile`) was not uploaded. Redo step 1, `cd ~/dnd`, then deploy again. |
| "Container failed to start" | Read the log (step 8). A Python error at start-up is shown there. |
| `PermissionDenied` writing to `/data` in the log | The service account cannot use the bucket: repeat step 5 and check the deploy used `--service-account $SA`. |
| The browser keeps rejecting the password | The secret must hold exactly the password with no extra newline. Re-create it with `printf '%s'` as in step 6 option A (not `echo`), then repeat the deploy. |
| Your data is missing or resets | The bucket is not mounted: check both `--add-volume` options were in the step 7 deploy command, and that you copied data into the right bucket (step 4). |
| A YouTube link fails | See "Limits to know about". |

## Try the container on your own computer first (optional, needs Docker)

```bash
docker build -t dnd-tracker .
docker run --rm -p 8080:8080 -e DND_PASSWORD=test -v "$PWD/cloud-data:/data" dnd-tracker
```

Open http://localhost:8080 and use the password `test`. Your data appears in `./cloud-data/`.

## What was tested

On a laptop, without Docker or Google Cloud: the production server (gunicorn) started the app; with a password set the
pages and API refused a missing or wrong password and accepted the right one, while `/healthz` needed none; with
`DND_DATA_ROOT` pointing at another folder everything saved there and the project's own `data/` was untouched;
and a restart reloaded the saved state.
