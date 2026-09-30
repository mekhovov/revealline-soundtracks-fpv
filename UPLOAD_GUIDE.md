# Add songs to the separate FPV archive

This repository is `mekhovov/revealline-soundtracks-fpv`. The main RevealLine
soundtrack archive remains licensed-only. A publication here does not add music
to the game's defaults; players must explicitly select this source.

## One song or a folder

```sh
git clone git@github.com:mekhovov/revealline-soundtracks-fpv.git
cd revealline-soundtracks-fpv
git switch main
git pull --ff-only
node intake/add-music.mjs "/absolute/path/to/songs" \
  --source "https://www.youtube.com/@TRENCH_ORDERLY" \
  --artist "TRENCH ORDERLY" \
  --collections "TRENCH ORDERLY,ФПВ" \
  --description "Пісні про ФПВ" \
  --styles "ФПВ,UA" \
  --license unknown \
  --confirm-rights \
  --open-pr
```

Use Node 20 or newer, Git, authenticated GitHub CLI, ffmpeg and ffprobe. The
checkout must be clean. At most 20 songs/64 MiB per intake; split larger folders.
Keep original files. A matching existing audio hash is rejected as a duplicate.

`unknown` preserves the uploader's existing assertion about public redistribution
and playback; it is **not an open licence**. A YouTube link alone is not licence
evidence. Confirm rights only when you have verified them, and retain exact
evidence with `--rights-evidence`. Other supported options remain `cc0`,
`cc-by-3.0`, `cc-by-4.0`, `cc-by-sa-3.0` and `cc-by-sa-4.0`.
CC BY-SA also requires `--derivative-notice` and the creator's exact attribution.

## Browser form

1. Open [Add music](https://mekhovov.github.io/revealline-soundtracks-fpv/#add-music).
2. Choose files/folder or stable hosted MP3 URLs.
3. Enter artist/title, creator source, styles, collections and accurate licence.
4. Confirm your recording-specific publication rights and download `.rlintake`.
5. In this repository run:

```sh
node intake/add-music.mjs "/absolute/path/package.rlintake" --open-pr
```

The form keeps files on your device until you deliberately submit the package
with the local command. Pages does not store GitHub credentials or directly open
a pull request.

## Hosted MP3 without copying audio into GitHub

```sh
node intake/add-music.mjs \
  --audio-url "https://example-bucket.s3.eu-central-1.amazonaws.com/music/song.mp3" \
  --title "Song title" --artist "Artist" \
  --source "https://artist.example/song" \
  --styles "ФПВ,UA" --collections "Artist,ФПВ" \
  --license unknown --confirm-rights --open-pr
```

Use a stable HTTPS public MP3 URL, not a presigned URL. The host must support
anonymous CORS, HEAD and Range requests. The script verifies complete bytes twice,
records SHA-256/size/duration and rejects redirects to private destinations,
expiring URLs, truncated files and changed bytes. `--url-manifest manifest.json`
supports several URLs. No audio release is created for hosted recordings.

## Review and publication

Local audio becomes public in a verified, non-latest audio prerelease before PR
review. No existing asset is overwritten. After checks and independent review,
merge the PR; Pages deployment runs automatically. Verify search, one track,
Next and a shared filter URL. Catalogue rows remain game-unadmitted and
Recording-mode ineligible; publication is not listening approval.
