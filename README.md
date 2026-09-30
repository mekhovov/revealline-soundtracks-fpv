# RevealLine FPV Soundtracks

Separate, explicitly selected FPV soundtrack collection with search, artist/style/
collection filters, shareable lists and same-page playback. It is not part of the
main RevealLine licensed soundtrack archive or its default playlists.

Existing recording licence labels and credits will be preserved. An unknown
licence remains unknown; publication does not grant reuse rights or claim an
open licence.

- [Player](https://mekhovov.github.io/revealline-soundtracks-fpv/)
- [Catalogue JSON](https://mekhovov.github.io/revealline-soundtracks-fpv/catalogue.json)
- [Web upload guide](https://mekhovov.github.io/revealline-soundtracks-fpv/upload-guide/)
- [Full CLI guide](UPLOAD_GUIDE.md)

## Initial migration

73 existing recordings total **207,941,311 bytes**. The source snapshot is pinned
to main archive commit `592364a67277744f795af787fc46b31e003fe02c`. IDs, metadata,
licence labels, audio hashes and byte counts are preserved exactly.
`migration-inventory.json` binds every source release URL to its destination
hash-addressed object. No binary audio is downloaded to the local checkout.

The reviewed owner-branch workflow copies assets one at a time on a hosted runner,
verifies byte count/SHA-256/range support, uploads only missing exact assets to a
draft volume, verifies the complete release set and publishes the prerelease.
It never replaces assets. Pull requests have read-only permissions and cannot
publish. After the reviewed PR merges, main verifies the same assets, stages only
the declared Pages files and deploys the player.

## Future additions

Use this repository, not the main licensed archive. Local MP3/folder intake and
hosted URL intake are supported. Browser-created `.rlintake` packages still need
one local authenticated command to open a PR; GitHub credentials never enter Pages.
Unknown rights require the existing explicit uploader confirmation and remain
labelled UNKNOWN. Publication grants no new licence and never changes main-archive
eligibility or game defaults. Known licences retain their exact attribution terms.

Run `node --test test-*.mjs`, `node verify.mjs`, and `git diff --check` for local
metadata verification. Full byte verification and deployment run on GitHub to
preserve the local 1 GiB free-space floor.
