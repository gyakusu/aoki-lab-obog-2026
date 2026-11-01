const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_FILES = 3;
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const MAX_PENDING_PHOTOS = 200;
const MAX_PENDING_BYTES = 100 * 1024 * 1024;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const DECADES = new Set(["1970年代", "1980年代", "1990年代", "2000年代", "2010年代", "2020年代", "年代不明"]);
const MEDIA_TYPES = new Map([
  ["image/jpeg", { extension: "jpg", format: "jpeg" }],
  ["image/png", { extension: "png", format: "png" }],
  ["image/webp", { extension: "webp", format: "webp" }]
]);
const GITHUB_API = "https://api.github.com";

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers }
  });
}

function corsHeaders(origin) {
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "600",
    vary: "Origin"
  };
}

function cleanText(value, maxLength) {
  if (typeof value !== "string") return "";
  return [...value].filter((character) => {
    const code = character.charCodeAt(0);
    return !(code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127);
  }).join("").trim().slice(0, maxLength);
}

function startsWith(bytes, values, offset = 0) {
  return values.every((value, index) => bytes[offset + index] === value);
}

function imageFormat(bytes) {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "jpeg";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return "webp";
  return null;
}

function imageDimensions(bytes, format) {
  let width = 0;
  let height = 0;
  if (format === "png" && bytes.length >= 24) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    width = view.getUint32(16);
    height = view.getUint32(20);
  } else if (format === "webp") {
    let offset = 12;
    while (offset + 8 <= bytes.length) {
      const length = new DataView(bytes.buffer, bytes.byteOffset + offset + 4, 4).getUint32(0, true);
      if (offset + 8 + length > bytes.length) break;
      if (startsWith(bytes, [0x56, 0x50, 0x38, 0x58], offset)) {
        width = 1 + bytes[offset + 12] + (bytes[offset + 13] << 8) + (bytes[offset + 14] << 16);
        height = 1 + bytes[offset + 15] + (bytes[offset + 16] << 8) + (bytes[offset + 17] << 16);
        break;
      }
      if (startsWith(bytes, [0x56, 0x50, 0x38, 0x20], offset) && startsWith(bytes, [0x9d, 0x01, 0x2a], offset + 11)) {
        width = (bytes[offset + 14] | (bytes[offset + 15] << 8)) & 0x3fff;
        height = (bytes[offset + 16] | (bytes[offset + 17] << 8)) & 0x3fff;
        break;
      }
      if (startsWith(bytes, [0x56, 0x50, 0x38, 0x4c], offset) && bytes[offset + 8] === 0x2f) {
        width = 1 + (((bytes[offset + 10] & 0x3f) << 8) | bytes[offset + 9]);
        height = 1 + (((bytes[offset + 12] & 0x0f) << 10) | (bytes[offset + 11] << 2) | ((bytes[offset + 10] & 0xc0) >> 6));
        break;
      }
      offset += 8 + length + (length % 2);
    }
  } else if (format === "jpeg") {
    let offset = 2;
    while (offset + 4 <= bytes.length && bytes[offset] === 0xff) {
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      const length = (bytes[offset] << 8) | bytes[offset + 1];
      if (length < 2 || offset + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        height = (bytes[offset + 3] << 8) | bytes[offset + 4];
        width = (bytes[offset + 5] << 8) | bytes[offset + 6];
        break;
      }
      offset += length;
    }
  }
  if (!width || !height || width * height > 40_000_000) {
    throw new Error("画像のサイズが不正か、大きすぎます（最大4000万画素）。");
  }
  return { width, height };
}

function hasExif(bytes, format) {
  if (format === "png") {
    let offset = 8;
    while (offset + 12 <= bytes.length) {
      const length = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0);
      if (offset + 12 + length > bytes.length) throw new Error("画像のメタデータ構造が不正です。");
      if (startsWith(bytes, [0x65, 0x58, 0x49, 0x66], offset + 4)) return true;
      offset += 12 + length;
    }
    return false;
  }
  if (format === "webp") {
    let offset = 12;
    while (offset + 8 <= bytes.length) {
      const length = new DataView(bytes.buffer, bytes.byteOffset + offset + 4, 4).getUint32(0, true);
      if (offset + 8 + length > bytes.length) throw new Error("画像のメタデータ構造が不正です。");
      if (startsWith(bytes, [0x45, 0x58, 0x49, 0x46], offset)) return true;
      offset += 8 + length + (length % 2);
    }
    return false;
  }
  if (format === "jpeg") {
    let offset = 2;
    while (offset + 4 <= bytes.length && bytes[offset] === 0xff) {
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      const length = (bytes[offset] << 8) | bytes[offset + 1];
      if (length < 2 || offset + length > bytes.length) throw new Error("画像のメタデータ構造が不正です。");
      if (marker === 0xe1 && startsWith(bytes, [0x45, 0x78, 0x69, 0x66, 0x00, 0x00], offset + 2)) return true;
      offset += length;
    }
    return false;
  }
  return false;
}

function validateImage(file) {
  if (!file || !(file instanceof File)) throw new Error("画像ファイルを確認できません。");
  if (!MEDIA_TYPES.has(file.type)) throw new Error("JPEG、PNG、WebP 形式の画像を選択してください。");
  if (file.size < 1 || file.size > MAX_FILE_BYTES) throw new Error("1枚あたりの上限は5MBです。");
  return file.arrayBuffer().then((buffer) => {
    const bytes = new Uint8Array(buffer);
    const format = imageFormat(bytes);
    if (format !== MEDIA_TYPES.get(file.type).format) throw new Error("ファイル形式と画像の内容が一致しません。");
    imageDimensions(bytes, format);
    if (hasExif(bytes, format)) throw new Error("EXIF メタデータを含む画像は受け付けられません。再度写真を選択してください。");
    return { file, buffer, format };
  });
}

async function checkAdminPassword(request, env) {
  if (!env.ADMIN_PASSWORD) throw new Error("管理パスワードが Worker Secret に設定されていません。");
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const encoder = new TextEncoder();
  const [expectedHash, suppliedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(env.ADMIN_PASSWORD)),
    crypto.subtle.digest("SHA-256", encoder.encode(supplied))
  ]);
  const expected = new Uint8Array(expectedHash);
  const actual = new Uint8Array(suppliedHash);
  let difference = 0;
  for (let index = 0; index < expected.length; index++) difference |= expected[index] ^ actual[index];
  return difference === 0 && supplied.length > 0;
}

async function githubRequest(env, pathname, options = {}) {
  if (!env.GITHUB_TOKEN) throw new Error("GitHub token is not configured in Worker Secrets.");
  const response = await fetch(`${GITHUB_API}${pathname}`, {
    ...options,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "x-github-api-version": "2022-11-28",
      "content-type": "application/json",
      "user-agent": "aoki-lab-obog-photo-approval",
      ...options.headers
    }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error("GitHub API request failed", response.status, body.message);
    throw new Error(`GitHub への公開処理に失敗しました（${response.status}）。未承認データは保管されています。`);
  }
  return body;
}

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
  }
  return btoa(binary);
}

async function publishPhoto(env, id, metadata, imageObject) {
  const owner = encodeURIComponent(env.GITHUB_OWNER);
  const repo = encodeURIComponent(env.GITHUB_REPO);
  const branch = encodeURIComponent(env.GITHUB_BRANCH || "main");
  const base = `/repos/${owner}/${repo}`;
  const ref = await githubRequest(env, `${base}/git/ref/heads/${branch}`);
  const parentSha = ref.object.sha;
  const parentCommit = await githubRequest(env, `${base}/git/commits/${parentSha}`);
  const imagePath = `photos/approved/${id}.${MEDIA_TYPES.get(metadata.mimeType).extension}`;
  const metadataPath = `photos/approved/${id}.json`;
  const publicMetadata = {
    id,
    name: metadata.name,
    enrollmentYear: metadata.enrollmentYear,
    decade: metadata.decade,
    caption: metadata.caption,
    imageFile: `${id}.${MEDIA_TYPES.get(metadata.mimeType).extension}`,
    createdAt: metadata.createdAt
  };
  const [imageBlob, metadataBlob] = await Promise.all([
    githubRequest(env, `${base}/git/blobs`, {
      method: "POST",
      body: JSON.stringify({ content: toBase64(await imageObject.arrayBuffer()), encoding: "base64" })
    }),
    githubRequest(env, `${base}/git/blobs`, {
      method: "POST",
      body: JSON.stringify({ content: JSON.stringify(publicMetadata, null, 2), encoding: "utf-8" })
    })
  ]);
  const tree = await githubRequest(env, `${base}/git/trees`, {
    method: "POST",
    body: JSON.stringify({
      base_tree: parentCommit.tree.sha,
      tree: [
        { path: imagePath, mode: "100644", type: "blob", sha: imageBlob.sha },
        { path: metadataPath, mode: "100644", type: "blob", sha: metadataBlob.sha }
      ]
    })
  });
  const commit = await githubRequest(env, `${base}/git/commits`, {
    method: "POST",
    body: JSON.stringify({
      message: `Approve photo ${id}`,
      tree: tree.sha,
      parents: [parentSha]
    })
  });
  await githubRequest(env, `${base}/git/refs/heads/${branch}`, {
    method: "PATCH",
    body: JSON.stringify({ sha: commit.sha, force: false })
  });
}

function adminPageHeaders() {
  return {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
  };
}

async function listPending(env) {
  const photos = [];
  let cursor;
  do {
    const page = await env.PENDING_PHOTOS.list({ prefix: "pending/", cursor, limit: 100 });
    for (const item of page.objects) {
      if (!item.key.endsWith(".json")) continue;
      const object = await env.PENDING_PHOTOS.get(item.key);
      if (!object) continue;
      const metadata = await object.json();
      photos.push({ ...metadata, id: item.key.slice("pending/".length, -5) });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return photos.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

async function pendingUsage(env) {
  let count = 0;
  let bytes = 0;
  let cursor;
  do {
    const page = await env.PENDING_PHOTOS.list({ prefix: "pending/", cursor, limit: 1000 });
    for (const item of page.objects) {
      if (!item.key.endsWith(".bin")) continue;
      count++;
      bytes += item.size;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return { count, bytes };
}

async function handleUpload(request, env) {
  const origin = request.headers.get("origin");
  if (!origin || origin !== env.PAGES_ORIGIN) return json({ error: "このサイトからのみ投稿できます。" }, 403);
  if (Number(request.headers.get("content-length") || 0) > MAX_REQUEST_BYTES) {
    return json({ error: "1回あたりの合計サイズは15MBまでです。" }, 413, corsHeaders(origin));
  }
  const rate = await env.UPLOAD_LIMITER.limit({ key: request.headers.get("CF-Connecting-IP") || "unknown" });
  if (!rate.success) return json({ error: "投稿回数の上限に達しました。時間をおいて再度お試しください。" }, 429, corsHeaders(origin));

  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ error: "投稿データを読み取れませんでした。" }, 400, corsHeaders(origin));
  }
  const name = cleanText(form.get("name"), 80);
  const caption = cleanText(form.get("caption"), 500);
  const yearValue = cleanText(form.get("enrollmentYear"), 4);
  const decade = cleanText(form.get("decade"), 20);
  const enrollmentYear = Number(yearValue);
  const files = form.getAll("photos");
  if (!name || !caption || !/^\d{4}$/.test(yearValue) || enrollmentYear < 1950 || enrollmentYear > 2026 || !DECADES.has(decade)) {
    return json({ error: "投稿者名・入学年度・写真の年代・キャプションを正しく入力してください。" }, 400, corsHeaders(origin));
  }
  if (EMAIL_PATTERN.test(name) || EMAIL_PATTERN.test(caption)) {
    return json({ error: "投稿者名やキャプションにメールアドレスを入力しないでください。" }, 400, corsHeaders(origin));
  }
  if (files.length < 1 || files.length > MAX_FILES) {
    return json({ error: "写真は1回につき1〜3枚選択してください。" }, 400, corsHeaders(origin));
  }

  let validated;
  try {
    validated = await Promise.all(files.map(validateImage));
  } catch (error) {
    return json({ error: error.message }, 400, corsHeaders(origin));
  }
  const totalSize = validated.reduce((sum, item) => sum + item.file.size, 0);
  if (totalSize > 15 * 1024 * 1024) return json({ error: "1回あたりの合計サイズは15MBまでです。" }, 413, corsHeaders(origin));
  let usage;
  try {
    usage = await pendingUsage(env);
  } catch (error) {
    console.error("Could not check pending storage quota", error);
    return json({ error: "投稿受付の状態を確認できませんでした。時間をおいて再度お試しください。" }, 503, corsHeaders(origin));
  }
  if (usage.count + validated.length > MAX_PENDING_PHOTOS || usage.bytes + totalSize > MAX_PENDING_BYTES) {
    return json({ error: "未承認写真の保管上限に達しています。幹事が確認するまで時間をおいてください。" }, 503, corsHeaders(origin));
  }

  const createdAt = new Date().toISOString();
  const savedKeys = [];
  try {
    for (const { file, buffer, format } of validated) {
      const id = crypto.randomUUID();
      const metadata = { id, name, enrollmentYear, decade, caption, mimeType: file.type, createdAt };
      const imageKey = `pending/${id}.bin`;
      const metadataKey = `pending/${id}.json`;
      await env.PENDING_PHOTOS.put(imageKey, buffer, { httpMetadata: { contentType: file.type } });
      savedKeys.push(imageKey);
      await env.PENDING_PHOTOS.put(metadataKey, JSON.stringify(metadata), { httpMetadata: { contentType: "application/json" } });
      savedKeys.push(metadataKey);
      if (format !== MEDIA_TYPES.get(file.type).format) throw new Error("Image format changed during validation.");
    }
  } catch (error) {
    await Promise.all(savedKeys.map((key) => env.PENDING_PHOTOS.delete(key)));
    console.error("Could not save pending upload", error);
    return json({ error: "投稿を保管できませんでした。時間をおいて再度お試しください。" }, 500, corsHeaders(origin));
  }
  return json({ accepted: validated.length, status: "pending" }, 201, corsHeaders(origin));
}

async function handleAdmin(request, env, url) {
  let authenticated;
  try {
    authenticated = await checkAdminPassword(request, env);
  } catch (error) {
    console.error("Admin authentication is not configured", error);
    return json({ error: "管理画面の設定に問題があります。" }, 503);
  }
  if (!authenticated) return json({ error: "パスワードが正しくありません。" }, 401);

  if (request.method === "GET" && url.pathname === "/api/admin/pending") {
    try {
      return json({ photos: await listPending(env) });
    } catch (error) {
      console.error("Could not list pending photos", error);
      return json({ error: "未承認写真を取得できませんでした。" }, 500);
    }
  }

  const match = url.pathname.match(/^\/api\/admin\/pending\/([a-f0-9-]{36})\/(image|approve|delete)$/i);
  if (!match) return json({ error: "指定された投稿が見つかりません。" }, 404);
  const [, id, action] = match;
  const metadataKey = `pending/${id}.json`;
  const metadataObject = await env.PENDING_PHOTOS.get(metadataKey);
  if (!metadataObject) return json({ error: "この投稿はすでに処理済みか、見つかりません。" }, 404);

  if (request.method === "GET" && action === "image") {
    const metadata = await metadataObject.json();
    const imageObject = await env.PENDING_PHOTOS.get(`pending/${id}.bin`);
    if (!imageObject) return json({ error: "画像データが見つかりません。" }, 404);
    return new Response(imageObject.body, {
      headers: {
        "content-type": metadata.mimeType,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; frame-ancestors 'none'"
      }
    });
  }

  if (request.method === "DELETE" && action === "delete") {
    await Promise.all([env.PENDING_PHOTOS.delete(metadataKey), env.PENDING_PHOTOS.delete(`pending/${id}.bin`)]);
    return json({ deleted: true });
  }

  if (request.method === "POST" && action === "approve") {
    const metadata = await metadataObject.json();
    const imageObject = await env.PENDING_PHOTOS.get(`pending/${id}.bin`);
    if (!imageObject) return json({ error: "画像データが見つかりません。" }, 404);
    if (!MEDIA_TYPES.has(metadata.mimeType)) return json({ error: "画像形式が不正なため承認できません。" }, 400);
    try {
      await publishPhoto(env, id, metadata, imageObject);
      await Promise.all([env.PENDING_PHOTOS.delete(metadataKey), env.PENDING_PHOTOS.delete(`pending/${id}.bin`)]);
      return json({ approved: true, id });
    } catch (error) {
      console.error("Could not approve pending photo", id, error);
      return json({ error: error.message || "公開に失敗しました。未承認データは保管されています。" }, 502);
    }
  }

  return json({ error: "この操作は許可されていません。" }, 405);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && (url.pathname === "/admin" || url.pathname === "/admin/")) {
      const asset = await env.ASSETS.fetch(new Request(new URL("/admin.html", request.url)));
      return new Response(asset.body, { status: asset.status, headers: adminPageHeaders() });
    }

    if (url.pathname === "/api/upload" && request.method === "OPTIONS") {
      const origin = request.headers.get("origin");
      if (!origin || origin !== env.PAGES_ORIGIN) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (url.pathname === "/api/upload" && request.method === "POST") return handleUpload(request, env);
    if (url.pathname.startsWith("/api/admin/")) return handleAdmin(request, env, url);
    return json({ error: "Not found" }, 404);
  }
};
