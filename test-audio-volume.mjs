import assert from "node:assert/strict";
import test from "node:test";
import {
  assertReleaseVolume,
  promoteAudioVolume,
  RELEASE_VOLUME_FIELDS,
} from "./intake/audio-volume.mjs";

const volume = {
  releaseTag: "audio-test-volume",
  assets: [
    { sha256: "a".repeat(64), bytes: 3 },
    { sha256: "b".repeat(64), bytes: 5 },
  ],
};
const release = (flags = {}) => ({
  tagName: volume.releaseTag,
  isDraft: false,
  isPrerelease: true,
  assets: volume.assets.map(({ sha256, bytes }) => ({
    name: `${sha256}.mp3`,
    size: bytes,
    state: "uploaded",
    digest: `sha256:${sha256}`,
  })),
  ...flags,
});
const repo = "mekhovov/revealline-soundtracks-fpv";

test("exact public prerelease or release volumes can be reused without uploads", () => {
  for (const isPrerelease of [true, false]) {
    assert.deepEqual(assertReleaseVolume(release({ isPrerelease }), volume), {
      missingAssets: [],
    });
  }
});

test("only a draft may resume an exact partial upload", () => {
  const partial = release({ isDraft: true });
  partial.assets.pop();
  assert.deepEqual(
    assertReleaseVolume(partial, volume, { allowMissing: true }),
    {
      missingAssets: [volume.assets[1]],
    },
  );
  assert.throws(() => assertReleaseVolume(partial, volume), /incomplete/);
  assert.throws(
    () =>
      assertReleaseVolume({ ...partial, isDraft: false }, volume, {
        allowMissing: true,
      }),
    /incomplete/,
  );
});

test("partial retry rejects corrupted, extra, duplicate or unconfirmed assets", () => {
  for (const mutate of [
    (value) => {
      value.tagName = "audio-wrong";
    },
    (value) => {
      value.assets[0].size += 1;
    },
    (value) => {
      value.assets[0].digest = `sha256:${"c".repeat(64)}`;
    },
    (value) => {
      delete value.assets[0].digest;
    },
    (value) => {
      value.assets[0].state = "starter";
    },
    (value) => {
      value.assets[0].name = "unexpected.mp3";
    },
    (value) => {
      value.assets[1] = value.assets[0];
    },
    (value) => {
      value.assets.push(value.assets[0]);
    },
    (value) => {
      delete value.isDraft;
    },
    (value) => {
      delete value.isPrerelease;
    },
  ]) {
    const altered = release({ isDraft: true });
    mutate(altered);
    assert.throws(
      () => assertReleaseVolume(altered, volume, { allowMissing: true }),
      /Release/,
    );
  }
});

test("manifest rejects repeated hashes, invalid sizes or unsupported tags", () => {
  for (const mutate of [
    (value) => {
      value.releaseTag = "../tag";
    },
    (value) => {
      value.assets[0].bytes = 0;
    },
    (value) => {
      value.assets[0].bytes = Number.MAX_SAFE_INTEGER + 1;
    },
    (value) => {
      value.assets[0].sha256 = "not-a-hash";
    },
    (value) => {
      value.assets[1] = value.assets[0];
    },
    (value) => {
      value.assets = [];
    },
  ]) {
    const altered = structuredClone(volume);
    mutate(altered);
    assert.throws(
      () => assertReleaseVolume(release(), altered),
      /Audio volume/,
    );
  }
});

test("main promotes an exact prerelease using metadata only and verifies the result", async () => {
  const calls = [];
  let reads = 0;
  const result = await promoteAudioVolume(volume, {
    repo,
    run: async (args) => {
      calls.push(args);
      if (args[1] === "view")
        return JSON.stringify(release({ isPrerelease: ++reads === 1 }));
      assert.equal(args[1], "edit");
      return "";
    },
  });
  assert.equal(result, "promoted");
  assert.deepEqual(calls, [
    [
      "release",
      "view",
      volume.releaseTag,
      "--repo",
      repo,
      "--json",
      RELEASE_VOLUME_FIELDS,
    ],
    [
      "release",
      "edit",
      volume.releaseTag,
      "--repo",
      repo,
      "--draft=false",
      "--prerelease=false",
      "--latest=false",
    ],
    [
      "release",
      "view",
      volume.releaseTag,
      "--repo",
      repo,
      "--json",
      RELEASE_VOLUME_FIELDS,
    ],
  ]);
});

test("main supports legacy complete drafts and published full volumes without asset changes", async () => {
  for (const isDraft of [true, false]) {
    const calls = [];
    let reads = 0;
    const result = await promoteAudioVolume(volume, {
      repo,
      run: async (args) => {
        calls.push(args);
        return args[1] === "view"
          ? JSON.stringify(
              release({
                isDraft: isDraft && ++reads === 1,
                isPrerelease: false,
              }),
            )
          : "";
      },
    });
    assert.equal(result, isDraft ? "published" : "verified");
    assert.equal(calls.length, isDraft ? 3 : 1);
    assert.ok(calls.every((args) => ["view", "edit"].includes(args[1])));
  }
});

test("main never promotes an incomplete or drifted volume", async () => {
  for (const assets of [
    [],
    release().assets.slice(0, 1),
    [{ ...release().assets[0], size: 99 }],
  ]) {
    const calls = [];
    await assert.rejects(
      promoteAudioVolume(volume, {
        repo,
        run: async (args) => {
          calls.push(args);
          return JSON.stringify(release({ assets }));
        },
      }),
      /Release/,
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1], "view");
  }
});

test("main rejects unconfirmed promotion or drift after metadata update", async () => {
  for (const finalRelease of [
    release(),
    release({ isPrerelease: false, assets: [] }),
  ]) {
    let reads = 0;
    await assert.rejects(
      promoteAudioVolume(volume, {
        repo,
        run: async (args) =>
          args[1] === "view"
            ? JSON.stringify(++reads === 1 ? release() : finalRelease)
            : "",
      }),
      /promotion was not confirmed|incomplete/,
    );
  }
});

test("lookup failures and invalid manifests cannot trigger publication", async () => {
  let calls = 0;
  const run = async () => {
    calls += 1;
    throw new Error("GitHub HTTP 403");
  };
  await assert.rejects(promoteAudioVolume(volume, { repo, run }), /HTTP 403/);
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(
    promoteAudioVolume({ releaseTag: "bad", assets: [] }, { repo, run }),
    /manifest/,
  );
  assert.equal(calls, 0);
});
