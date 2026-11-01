import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const buildArgs = process.execPath.includes("deno")
  ? ["run", "--allow-all", "--node-modules-dir=auto", "scripts/build-site.js"]
  : ["scripts/build-site.js"];

function runBuild(env = process.env) {
  execFileSync(process.execPath, buildArgs, { cwd: root, stdio: "pipe", env });
}

test("publication build refuses incomplete event details", () => {
  assert.throws(() => runBuild({ ...process.env, REQUIRE_EVENT_READY: "1" }), (error) => {
    assert.match(error.stderr.toString(), /meetingPlace/);
    return true;
  });
});

test("build publishes approved originals and metadata-free thumbnails", async () => {
  const id = crypto.randomUUID();
  const sourceDirectory = path.join(root, "photos", "approved");
  const sourcePath = path.join(sourceDirectory, `${id}.png`);
  const metadataPath = path.join(sourceDirectory, `${id}.json`);
  const photosDirectory = path.join(root, "photos");
  const hadPhotosDirectory = await stat(photosDirectory).then(() => true).catch(() => false);
  const hadSourceDirectory = await stat(sourceDirectory).then(() => true).catch(() => false);

  await mkdir(sourceDirectory, { recursive: true });
  try {
    const image = await sharp({ create: { width: 48, height: 24, channels: 3, background: "#397" } }).png().toBuffer();
    await writeFile(sourcePath, image);
    await writeFile(metadataPath, JSON.stringify({
      id,
      name: "Test User",
      enrollmentYear: 2000,
      decade: "2000年代",
      caption: "Build pipeline test",
      imageFile: `${id}.png`,
      createdAt: new Date().toISOString()
    }));

    runBuild();

    const gallery = JSON.parse(await readFile(path.join(root, "site", "generated", "gallery.json"), "utf8"));
    const photo = gallery.find((item) => item.id === id);
    assert.ok(photo);
    assert.equal(photo.image, `photos/approved/${id}.png`);
    assert.equal(photo.thumbnail, `photos/thumbs/${id}.webp`);
    const publicImage = path.join(root, "site", photo.image);
    const thumbnail = path.join(root, "site", photo.thumbnail);
    assert.ok((await stat(publicImage)).size > 0);
    const thumbnailMetadata = await sharp(thumbnail).metadata();
    assert.equal(thumbnailMetadata.format, "webp");
    assert.equal(thumbnailMetadata.exif, undefined);
    assert.equal(thumbnailMetadata.width, 48);
    assert.equal(thumbnailMetadata.height, 24);
  } finally {
    await Promise.all([rm(sourcePath, { force: true }), rm(metadataPath, { force: true })]);
    await Promise.all([
      rm(path.join(root, "site", "photos", "approved", `${id}.png`), { force: true }),
      rm(path.join(root, "site", "photos", "thumbs", `${id}.webp`), { force: true })
    ]);
    if (!hadSourceDirectory && (await readdir(sourceDirectory)).length === 0) {
      await rm(sourceDirectory, { recursive: false });
    }
    if (!hadPhotosDirectory && (await readdir(photosDirectory)).length === 0) {
      await rm(path.join(root, "photos"), { recursive: false });
    }
    runBuild();
  }
});
