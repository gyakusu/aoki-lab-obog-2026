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
  form.set("enrollmentYear", "2000");
  form.set("decade", "2000年代");
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

test("upload rejects email addresses in public contributor fields", async () => {
  const env = makeEnv();
  const image = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#abc" } }).png().toBuffer();
  const form = new FormData();
  form.set("name", "person@example.com");
  form.set("enrollmentYear", "2000");
  form.set("decade", "2000年代");
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

test("upload rejects EXIF-bearing image metadata", async () => {
  const env = makeEnv();
  const plain = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#abc" } }).png().toBuffer();
  const exifChunk = Buffer.alloc(17);
  exifChunk.writeUInt32BE(5, 0);
  exifChunk.write("eXIf", 4, "ascii");
  exifChunk.write("GPS!", 8, "ascii");
  const withExif = Buffer.concat([plain.subarray(0, plain.length - 12), exifChunk, plain.subarray(plain.length - 12)]);
  const response = await uploadRequest(env, withExif);
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /EXIF/);
  assert.equal(env.PENDING_PHOTOS.objects.size, 0);
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
