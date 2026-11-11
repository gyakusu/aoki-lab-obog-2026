import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { markdownToHtml, maskPlaceholders, validateEventForPublication } from "../scripts/build-site.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const buildArgs = process.execPath.includes("deno")
  ? ["run", "--allow-all", "--node-modules-dir=auto", "scripts/build-site.js"]
  : ["scripts/build-site.js"];

function runBuild(env = process.env) {
  execFileSync(process.execPath, buildArgs, { cwd: root, stdio: "pipe", env });
}

function readyEvent() {
  const members = (start, count) => Array.from({ length: count }, (_, index) => `参加者${start + index}`);
  return {
    eventName: "青木研究室 OB・OG会",
    date: "2026-11-14",
    meetingStart: "15:00",
    dinnerStart: "18:30",
    visitorCount: 6,
    meetingPlace: "正門前",
    meetingMapUrl: "https://maps.example/meeting",
    dinnerPlace: "会食会場",
    dinnerAddress: "東京都新宿区",
    dinnerMapUrl: "https://maps.example/dinner",
    contactLabel: "幹事連絡先",
    contactDetails: "organizer@example.com",
    lateOrAbsentInstructions: "メールでご連絡ください。",
    groups: [
      { name: "A", leader: "引率A", members: members(1, 2) },
      { name: "B", leader: "引率B", members: members(3, 2) },
      { name: "C", leader: "引率C", members: members(5, 2) }
    ]
  };
}

test("publication check accepts complete event details", () => {
  assert.doesNotThrow(() => validateEventForPublication(readyEvent()));
});

test("publication check refuses incomplete event details", () => {
  const event = readyEvent();
  event.meetingPlace = "";
  assert.throws(() => validateEventForPublication(event), /meetingPlace/);
});

test("placeholder (dummy) values are hidden from the published event", () => {
  const event = readyEvent();
  event.dinnerPlace = "【ダミー】居酒屋";
  event.groups[1].members[0] = "ダミー参加者01";
  const { value, masked } = maskPlaceholders(event);
  assert.deepEqual(masked, ["dinnerPlace", "groups[1].members[0]"]);
  assert.equal(value.dinnerPlace, "");
  assert.deepEqual(value.groups[1].members, ["参加者4"]);
  assert.equal(value.meetingPlace, "正門前");
  assert.equal(event.dinnerPlace, "【ダミー】居酒屋", "source data must not be mutated");
});

test("publication build hides dummy values from the generated event page", async () => {
  runBuild();
  const generated = await readFile(path.join(root, "site", "generated", "event.json"), "utf8");
  assert.doesNotMatch(generated, /ダミー/);
});

test("publication check refuses mismatched member counts", () => {
  const event = readyEvent();
  event.visitorCount = 7;
  assert.throws(() => validateEventForPublication(event), /visitorCount/);
});

test("build publishes approved originals and metadata-free thumbnails", async () => {
  const id = crypto.randomUUID();
  const sourceDirectory = path.join(root, "photos", "approved");
  const sourcePath = path.join(sourceDirectory, `${id}.png`);
  const metadataPath = path.join(sourceDirectory, `${id}.json`);
  const olderId = crypto.randomUUID();
  const olderSourcePath = path.join(sourceDirectory, `${olderId}.png`);
  const olderMetadataPath = path.join(sourceDirectory, `${olderId}.json`);
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
      enrollmentYear: 2012,
      decade: "2010年代",
      caption: "Build pipeline test",
      imageFile: `${id}.png`,
      createdAt: "2026-11-03T10:00:00.000Z"
    }));
    await writeFile(olderSourcePath, image);
    await writeFile(olderMetadataPath, JSON.stringify({
      id: olderId,
      name: "青木",
      role: "faculty",
      enrollmentYear: null,
      decade: "2009年",
      caption: "Older photo",
      imageFile: `${olderId}.png`,
      createdAt: "2026-11-02T10:00:00.000Z"
    }));

    runBuild();

    const gallery = JSON.parse(await readFile(path.join(root, "site", "generated", "gallery.json"), "utf8"));
    const photo = gallery.find((item) => item.id === id);
    assert.ok(photo);
    const order = gallery.map((item) => item.id).filter((itemId) => itemId === id || itemId === olderId);
    assert.deepEqual(order, [id, olderId], "gallery must list newer photos first");
    const facultyPhoto = gallery.find((item) => item.id === olderId);
    assert.equal(facultyPhoto.role, "faculty");
    assert.equal(facultyPhoto.enrollmentYear, null);
    assert.equal(facultyPhoto.decade, "2009年");
    assert.equal(photo.role, undefined);
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
    await Promise.all([sourcePath, metadataPath, olderSourcePath, olderMetadataPath].map((file) => rm(file, { force: true })));
    await Promise.all([id, olderId].flatMap((photoId) => [
      rm(path.join(root, "site", "photos", "approved", `${photoId}.png`), { force: true }),
      rm(path.join(root, "site", "photos", "thumbs", `${photoId}.webp`), { force: true })
    ]));
    if (!hadSourceDirectory && (await readdir(sourceDirectory)).length === 0) {
      await rm(sourceDirectory, { recursive: false });
    }
    if (!hadPhotosDirectory && (await readdir(photosDirectory)).length === 0) {
      await rm(path.join(root, "photos"), { recursive: false });
    }
    runBuild();
  }
});

test("announcement markdown supports bullet and numbered lists", () => {
  const html = markdownToHtml("- a\n- b\n\n1. first\n2. second");
  assert.equal(html, "<ul><li>a</li><li>b</li></ul>\n<ol><li>first</li><li>second</li></ol>");
});
