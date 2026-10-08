# re-work — the reverse-engineering workspace the image carries

`Dockerfile.pi` copies this directory into the image at `/opt/re-work`, so a pi
session running in the container can read the Prime 4+ analysis without the
work ever being committed here.

```
docker build -f Dockerfile.pi -t pi-agent:latest .        # copies re-work/ in
docker run ... pi-agent:latest
  piuser@container:/home/piuser$ ls /opt/re-work
  prime4plus-5.0.4  PrimeBox
```

## Why it is staged rather than committed

This repository is public. The Prime 4+ case is not publishable material: it
contains vendor firmware, the filesystems and kernel image carved out of that
firmware, keys recovered from it, and a working root exploit against a shipping
device (`test-app-launcher`'s `wordexp` injection — see
`prime4plus-5.0.4/reports/`). The case's own `.gitignore` already refuses to
commit `samples/`, `extracted/` and `exports/` for exactly that reason, and
staging here extends the same rule to the repository as a whole.

Everything tracked in this directory is the two placeholders that keep it from
being empty. `git status` must stay clean after a staging run.

## Staging

```sh
./scripts/stage-re-work.sh              # sync from the workspace next to this repo
./scripts/stage-re-work.sh --check      # report what would change, copy nothing
./scripts/stage-re-work.sh --clean      # drop the staged copy (keeps the placeholders)
```

The source is `RE_WORK_SRC` — set it in `.env.local`, because it is a host path
and this file is committed. It defaults to the parent directory of this
repository, which is where the Prime 4+ workspace sits on the machine this
branch was built on:

```
<RE_WORK_SRC>/
  cases/prime4plus-5.0.4/          -> re-work/prime4plus-5.0.4/
  refs/PrimeBox/                   -> re-work/PrimeBox/
  PRIME4PLUS-5.0.4-Update.img      -> re-work/prime4plus-5.0.4/samples/   (only if absent)
```

`RE_WORK_EXTRA` takes additional `RE_WORK_SRC`-relative paths, space-separated,
for anything else that should travel with the image.

## What this costs

Staged, the Prime 4+ case is about 2.9 GB — 2.4 GB of it the extracted
filesystems and 453 MB the update image itself — and all of it becomes part of
the image layer. That is the point (the container is the analysis environment),
but it is not free: every `docker build` that changes this directory re-uploads
the build context, and the image is that much bigger to move. `--check` exists
so a rebuild for an unrelated change can be sanity-checked first.

`PrimeBox/` is staged without its `.git` directory and `__pycache__` is dropped
everywhere; nothing else is filtered.

## Tools the image gained for this

The image already had the compilers. It now also has the extraction side of the
case's own reproduction recipe (`prime4plus-5.0.4/README.md`), so the work can
be continued inside the container rather than only read: `debugfs` (e2fsprogs),
`unsquashfs` (squashfs-tools), `xz`, `cpio`, `dtc`, `file` and `binutils`.
