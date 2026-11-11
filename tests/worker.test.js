import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import worker from "../worker/src/index.js";

class MemoryBucket {
  objects = new Map();

  put(key, value, options = {}) {
    const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new TextEncoder().encode(value);
    this.objects.set(key, { bytes, options });
  }

  get(key) {
    const object = this.objects.get(key);
    if (!object) return null;
    return {
      body: new Blob([object.bytes]).stream(),
      json: () => JSON.parse(new TextDecoder().decode(object.bytes)),
      arrayBuffer: () => object.bytes.slice().buffer,
      httpMetadata: object.options.httpMetadata
    };
  }

  delete(key) {
    this.objects.delete(key);
  }

  list({ prefix, cursor, limit }) {
    const keys = [...this.objects.keys()].filter((key) => key.startsWith(prefix)).sort();
    const start = cursor ? Number(cursor) : 0;
    const page = keys.slice(start, start + limit);
    return {
      objects: page.map((key) => ({ key, size: this.objects.get(key).bytes.length })),
      truncated: start + limit < keys.length,
      cursor: start + limit < keys.length ? String(start + limit) : undefined
    };
  }
}

function makeEnv(bucket = new MemoryBucket()) {
  return {
    PENDING_PHOTOS: bucket,
    UPLOAD_LIMITER: { limit: () => ({ success: true }) },
    ASSETS: { fetch: () => new Response("<html>admin</html>") },
    PAGES_ORIGIN: "https://example.github.io",
    ADMIN_PASSWORD: "test-password",
    GITHUB_TOKEN: "test-token",
    GITHUB_OWNER: "example",
    GITHUB_REPO: "photos",
    GITHUB_BRANCH: "main"
  };
}

function uploadRequest(env, image, origin = env.PAGES_ORIGIN, mimeType = "image/png") {
  const form = new FormData();
  form.set("name", "Test User");
  form.set("enrollmentYear", "2012");
  form.set("decade", "2010年代");
  form.set("caption", "研究室の写真");
  form.append("photos", new File([image], "sample", { type: mimeType }));
  return worker.fetch(new Request("https://worker.example/api/upload", {
    method: "POST",
    headers: { origin, "CF-Connecting-IP": "203.0.113.1" },
    body: form
  }), env);
}

test("upload keeps accepted photos private in pending storage", async () => {
  const env = makeEnv();
  const image = await sharp({ create: { width: 8, height: 6, channels: 3, background: "#4b8" } }).png().toBuffer();
  const response = await uploadRequest(env, image);
  assert.equal(response.status, 201);
  assert.equal((await response.json()).status, "pending");
  assert.equal(env.PENDING_PHOTOS.objects.size, 2);

  const listed = await worker.fetch(new Request("https://worker.example/api/admin/pending", {
    headers: { authorization: "Bearer test-password" }
  }), env);
  assert.equal(listed.status, 200);
  assert.equal((await listed.json()).photos.length, 1);
});

test("upload accepts JPEG, PNG, and WebP image data", async () => {
  const env = makeEnv();
  for (const [mimeType, format] of [["image/jpeg", "jpeg"], ["image/png", "png"], ["image/webp", "webp"]]) {
    const image = await sharp({ create: { width: 8, height: 6, channels: 3, background: "#4b8" } })
      .toFormat(format).toBuffer();
    const response = await uploadRequest(env, image, env.PAGES_ORIGIN, mimeType);
    assert.equal(response.status, 201, `${mimeType} should be accepted`);
  }
  assert.equal(env.PENDING_PHOTOS.objects.size, 6);
});

test("upload rejects an unapproved origin", async () => {
  const env = makeEnv();
  const image = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#abc" } }).png().toBuffer();
  const response = await uploadRequest(env, image, "https://attacker.example");
  assert.equal(response.status, 403);
  assert.equal(env.PENDING_PHOTOS.objects.size, 0);
});

test("upload rejects decades and enrollment years from before the lab existed", async () => {
  const image = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#abc" } }).png().toBuffer();
  for (const [enrollmentYear, decade] of [["2012", "2000年代"], ["1950", "2010年代"], ["2006", "2010年代"], ["2012", "2006年"], ["2012", "2027年"]]) {
    const env = makeEnv();
    const form = new FormData();
    form.set("name", "Test User");
    form.set("enrollmentYear", enrollmentYear);
    form.set("decade", decade);
    form.set("caption", "研究室の写真");
    form.append("photos", new File([image], "sample", { type: "image/png" }));
    const response = await worker.fetch(new Request("https://worker.example/api/upload", {
      method: "POST",
      headers: { origin: env.PAGES_ORIGIN, "CF-Connecting-IP": "203.0.113.1" },
      body: form
    }), env);
    assert.equal(response.status, 400, `${enrollmentYear} / ${decade} should be rejected`);
    assert.equal(env.PENDING_PHOTOS.objects.size, 0);
  }
});

test("upload rejects email addresses in public contributor fields", async () => {
  const env = makeEnv();
  const image = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#abc" } }).png().toBuffer();
  const form = new FormData();
  form.set("name", "person@example.com");
  form.set("enrollmentYear", "2012");
  form.set("decade", "2010年代");
  form.set("caption", "研究室の写真");
  form.append("photos", new File([image], "sample", { type: "image/png" }));
  const response = await worker.fetch(new Request("https://worker.example/api/upload", {
    method: "POST",
    headers: { origin: env.PAGES_ORIGIN, "CF-Connecting-IP": "203.0.113.1" },
    body: form
  }), env);
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /メールアドレス/);
  assert.equal(env.PENDING_PHOTOS.objects.size, 0);
});

test("upload rejects images larger than the server-side pixel limit", async () => {
  const env = makeEnv();
  const image = Buffer.from(await sharp({ create: { width: 2, height: 2, channels: 3, background: "#abc" } }).png().toBuffer());
  image.writeUInt32BE(50_000, 16);
  image.writeUInt32BE(50_000, 20);
  const response = await uploadRequest(env, image);
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /画素/);
});

test("upload strips EXIF-bearing PNG metadata before storing", async () => {
  const env = makeEnv();
  const plain = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#abc" } }).png().toBuffer();
  const exifChunk = Buffer.alloc(17);
  exifChunk.writeUInt32BE(5, 0);
  exifChunk.write("eXIf", 4, "ascii");
  exifChunk.write("GPS!", 8, "ascii");
  const withExif = Buffer.concat([plain.subarray(0, plain.length - 12), exifChunk, plain.subarray(plain.length - 12)]);
  const response = await uploadRequest(env, withExif);
  assert.equal(response.status, 201);
  assert.equal(env.PENDING_PHOTOS.objects.size, 2);
  const stored = [...env.PENDING_PHOTOS.objects.entries()].find(([key]) => key.endsWith(".bin"))[1];
  const storedText = Buffer.from(stored.bytes).toString("latin1");
  assert.ok(!storedText.includes("eXIf"), "stored PNG must not contain an eXIf chunk");
  assert.ok(!storedText.includes("GPS!"), "stored PNG must not contain EXIF payload bytes");
  const metadata = await sharp(Buffer.from(stored.bytes)).metadata();
  assert.equal(metadata.format, "png");
  assert.equal(metadata.width, 2);
  assert.equal(metadata.height, 2);
});

test("upload strips EXIF from JPEG photos before storing", async () => {
  const env = makeEnv();
  const withExif = await sharp({ create: { width: 8, height: 6, channels: 3, background: "#abc" } })
    .withExif({ IFD0: { Copyright: "test-copyright" } })
    .jpeg()
    .toBuffer();
  assert.ok((await sharp(withExif).metadata()).exif, "fixture JPEG should carry EXIF");
  const response = await uploadRequest(env, withExif, env.PAGES_ORIGIN, "image/jpeg");
  assert.equal(response.status, 201);
  const stored = [...env.PENDING_PHOTOS.objects.entries()].find(([key]) => key.endsWith(".bin"))[1];
  const storedBuffer = Buffer.from(stored.bytes);
  assert.ok(!storedBuffer.toString("latin1").includes("test-copyright"), "stored JPEG must not contain EXIF bytes");
  const metadata = await sharp(storedBuffer).metadata();
  assert.equal(metadata.format, "jpeg");
  assert.equal(metadata.width, 8);
  assert.equal(metadata.height, 6);
  assert.equal(metadata.exif, undefined);
});

test("admin routes reject an incorrect password", async () => {
  const env = makeEnv();
  const response = await worker.fetch(new Request("https://worker.example/api/admin/pending", {
    headers: { authorization: "Bearer wrong" }
  }), env);
  assert.equal(response.status, 401);
});

test("approval commits only approved photo data and clears pending objects", async (t) => {
  const env = makeEnv();
  const image = await sharp({ create: { width: 3, height: 3, channels: 3, background: "#abc" } }).png().toBuffer();
  const uploadResponse = await uploadRequest(env, image);
  assert.equal(uploadResponse.status, 201);
  const photo = (await (await worker.fetch(new Request("https://worker.example/api/admin/pending", {
    headers: { authorization: "Bearer test-password" }
  }), env)).json()).photos[0];
  const requests = [];
  const originalFetch = globalThis.fetch;
  let blobNumber = 0;
  globalThis.fetch = (input, init = {}) => {
    const url = new URL(input);
    requests.push({ url, init });
    if (url.pathname.endsWith("/git/ref/heads/main")) return Response.json({ object: { sha: "parent-sha" } });
    if (url.pathname.endsWith("/git/commits/parent-sha")) return Response.json({ tree: { sha: "base-tree" } });
    if (url.pathname.endsWith("/git/blobs")) {
      blobNumber++;
      return Response.json({ sha: `blob-${blobNumber}` });
    }
    if (url.pathname.endsWith("/git/trees")) return Response.json({ sha: "new-tree" });
    if (url.pathname.endsWith("/git/commits")) return Response.json({ sha: "new-commit" });
    if (url.pathname.endsWith("/git/refs/heads/main")) return Response.json({ object: { sha: "new-commit" } });
    return Response.json({ message: "unexpected API request" }, { status: 404 });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const response = await worker.fetch(new Request(`https://worker.example/api/admin/pending/${photo.id}/approve`, {
    method: "POST",
    headers: { authorization: "Bearer test-password" }
  }), env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { approved: true, id: photo.id });
  assert.equal(env.PENDING_PHOTOS.objects.size, 0);
  const treeRequest = requests.find(({ url }) => url.pathname.endsWith("/git/trees"));
  const tree = JSON.parse(treeRequest.init.body);
  assert.equal(tree.tree.length, 2);
  assert.ok(tree.tree.every((entry) => entry.path.startsWith("photos/approved/")));
});

function uploadForm(fields, image) {
  const form = new FormData();
  for (const [key, value] of Object.entries({
    name: "Test User", enrollmentYear: "2012", decade: "2010年代", caption: "研究室の写真", ...fields
  })) form.set(key, value);
  form.append("photos", new File([image], "sample", { type: "image/png" }));
  return form;
}

function postUpload(env, form) {
  return worker.fetch(new Request("https://worker.example/api/upload", {
    method: "POST",
    headers: { origin: env.PAGES_ORIGIN, "CF-Connecting-IP": "203.0.113.1" },
    body: form
  }), env);
}

test("upload rejects an over-long enrollment year instead of truncating it", async () => {
  const env = makeEnv();
  const image = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#abc" } }).png().toBuffer();
  const response = await postUpload(env, uploadForm({ enrollmentYear: "20125" }, image));
  assert.equal(response.status, 400);
  assert.equal(env.PENDING_PHOTOS.objects.size, 0);
});

test("invalid form input does not consume the upload rate limit", async () => {
  const env = makeEnv();
  let limitCalls = 0;
  env.UPLOAD_LIMITER = { limit: () => { limitCalls++; return { success: true }; } };
  const image = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#abc" } }).png().toBuffer();
  const response = await postUpload(env, uploadForm({ caption: "" }, image));
  assert.equal(response.status, 400);
  assert.equal(limitCalls, 0);
});

async function uploadAndGetPendingPhoto(env) {
  const image = await sharp({ create: { width: 3, height: 3, channels: 3, background: "#abc" } }).png().toBuffer();
  assert.equal((await uploadRequest(env, image)).status, 201);
  return (await (await worker.fetch(new Request("https://worker.example/api/admin/pending", {
    headers: { authorization: "Bearer test-password" }
  }), env)).json()).photos[0];
}

function mockGitHub(t, { refConflicts = 0 } = {}) {
  const requests = [];
  const originalFetch = globalThis.fetch;
  let refPatches = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input);
    requests.push({ url, init });
    if (url.pathname.endsWith("/git/ref/heads/main")) return Response.json({ object: { sha: "parent-sha" } });
    if (url.pathname.endsWith("/git/commits/parent-sha")) return Response.json({ tree: { sha: "base-tree" } });
    if (url.pathname.endsWith("/git/blobs")) return Response.json({ sha: `blob-${requests.length}` });
    if (url.pathname.endsWith("/git/trees")) return Response.json({ sha: "new-tree" });
    if (url.pathname.endsWith("/git/commits")) return Response.json({ sha: "new-commit" });
    if (url.pathname.endsWith("/git/refs/heads/main")) {
      refPatches++;
      if (refPatches <= refConflicts) return Response.json({ message: "Update is not a fast forward" }, { status: 422 });
      return Response.json({ object: { sha: "new-commit" } });
    }
    return Response.json({ message: "unexpected API request" }, { status: 404 });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  return { requests, refPatches: () => refPatches };
}

function approve(env, id, body) {
  return worker.fetch(new Request(`https://worker.example/api/admin/pending/${id}/approve`, {
    method: "POST",
    headers: { authorization: "Bearer test-password", ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined
  }), env);
}

test("approval retries when main moved during the commit (422)", async (t) => {
  const env = makeEnv();
  const photo = await uploadAndGetPendingPhoto(env);
  const github = mockGitHub(t, { refConflicts: 1 });
  const response = await approve(env, photo.id);
  assert.equal(response.status, 200);
  assert.equal(github.refPatches(), 2);
  assert.equal(env.PENDING_PHOTOS.objects.size, 0);
});

test("approval reports success when publishing worked but pending cleanup failed", async (t) => {
  const env = makeEnv();
  const photo = await uploadAndGetPendingPhoto(env);
  mockGitHub(t);
  env.PENDING_PHOTOS.delete = () => { throw new Error("R2 unavailable"); };
  const response = await approve(env, photo.id);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { approved: true, id: photo.id, cleanupFailed: true });
});

test("approval publishes caption and name corrected by the organizer", async (t) => {
  const env = makeEnv();
  const photo = await uploadAndGetPendingPhoto(env);
  const github = mockGitHub(t);
  const response = await approve(env, photo.id, { name: "訂正後の名前", caption: "訂正後のキャプション" });
  assert.equal(response.status, 200);
  const metadataBlob = github.requests
    .filter(({ url }) => url.pathname.endsWith("/git/blobs"))
    .map(({ init }) => JSON.parse(init.body))
    .find((body) => body.encoding === "utf-8");
  const published = JSON.parse(metadataBlob.content);
  assert.equal(published.name, "訂正後の名前");
  assert.equal(published.caption, "訂正後のキャプション");
});

test("approval rejects corrections that contain an email address", async (t) => {
  const env = makeEnv();
  const photo = await uploadAndGetPendingPhoto(env);
  mockGitHub(t);
  const response = await approve(env, photo.id, { caption: "連絡は a@example.com まで" });
  assert.equal(response.status, 400);
  assert.equal(env.PENDING_PHOTOS.objects.size, 2);
});

test("upload accepts a specific year as the photo period", async () => {
  const image = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#abc" } }).png().toBuffer();
  for (const decade of ["2007年", "2015年", "2026年", "2020年代", "年代不明"]) {
    const env = makeEnv();
    const response = await postUpload(env, uploadForm({ decade }, image));
    assert.equal(response.status, 201, `${decade} should be accepted`);
  }
});

test("faculty uploads do not require an enrollment year and publish the role", async (t) => {
  const env = makeEnv();
  const image = await sharp({ create: { width: 3, height: 3, channels: 3, background: "#abc" } }).png().toBuffer();
  const response = await postUpload(env, uploadForm({ role: "faculty", name: "青木", enrollmentYear: "", decade: "2009年" }, image));
  assert.equal(response.status, 201);
  const [photo] = (await (await worker.fetch(new Request("https://worker.example/api/admin/pending", {
    headers: { authorization: "Bearer test-password" }
  }), env)).json()).photos;
  assert.equal(photo.role, "faculty");
  assert.equal(photo.enrollmentYear, null);

  const github = mockGitHub(t);
  assert.equal((await approve(env, photo.id)).status, 200);
  const published = JSON.parse(github.requests
    .filter(({ url }) => url.pathname.endsWith("/git/blobs"))
    .map(({ init }) => JSON.parse(init.body))
    .find((body) => body.encoding === "utf-8").content);
  assert.equal(published.role, "faculty");
  assert.equal(published.enrollmentYear, null);
  assert.equal(published.decade, "2009年");
});

test("upload rejects unknown roles and alumni without an enrollment year", async () => {
  const image = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#abc" } }).png().toBuffer();
  for (const fields of [{ role: "admin" }, { role: "alumni", enrollmentYear: "" }]) {
    const env = makeEnv();
    const response = await postUpload(env, uploadForm(fields, image));
    assert.equal(response.status, 400, `${JSON.stringify(fields)} should be rejected`);
    assert.equal(env.PENDING_PHOTOS.objects.size, 0);
  }
});
