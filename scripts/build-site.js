import { readdir, readFile, mkdir, rm, stat, writeFile, copyFile, cp } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePhotos = path.join(root, "photos", "approved");
const siteRoot = path.join(root, "site");
const generatedRoot = path.join(siteRoot, "generated");
const publicPhotos = path.join(siteRoot, "photos");
const distributionRoot = path.join(root, "dist");
const softLimit = 100 * 1024 * 1024;
const hardLimit = 1024 * 1024 * 1024;
const validExtensions = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const htmlEscape = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");

function markdownInline(value) {
  let output = htmlEscape(value);
  output = output.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" rel="noopener noreferrer" target="_blank">$1</a>');
  output = output.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  output = output.replace(/`([^`]+)`/g, "<code>$1</code>");
  return output;
}

export function markdownToHtml(markdown) {
  const blocks = [];
  let paragraph = [];
  let list = [];
  let listTag = "ul";
  const flushParagraph = () => {
    if (paragraph.length) blocks.push(`<p>${paragraph.map(markdownInline).join("<br>")}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (list.length) blocks.push(`<${listTag}>${list.map((item) => `<li>${markdownInline(item)}</li>`).join("")}</${listTag}>`);
    list = [];
  };

  for (const line of markdown.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      flushParagraph();
      flushList();
    } else if (/^#{1,3}\s/.test(trimmed)) {
      flushParagraph();
      flushList();
      const level = trimmed.match(/^#+/)[0].length;
      blocks.push(`<h${level + 2}>${markdownInline(trimmed.replace(/^#{1,3}\s+/, ""))}</h${level + 2}>`);
    } else if (/^([-*]|\d+\.)\s+/.test(trimmed)) {
      flushParagraph();
      const tag = /^\d+\./.test(trimmed) ? "ol" : "ul";
      if (list.length && tag !== listTag) flushList();
      listTag = tag;
      list.push(trimmed.replace(/^([-*]|\d+\.)\s+/, ""));
    } else {
      flushList();
      paragraph.push(trimmed);
    }
  }
  flushParagraph();
  flushList();
  return blocks.join("\n");
}

function parseAnnouncement(filename, source) {
  const match = source.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/);
  if (!match) throw new Error(`${filename}: front matter (title/date) is required`);
  const frontMatter = Object.fromEntries(match[1].split(/\r?\n/).map((line) => {
    const separator = line.indexOf(":");
    if (separator < 0) throw new Error(`${filename}: invalid front matter line`);
    return [line.slice(0, separator).trim(), line.slice(separator + 1).trim().replace(/^["']|["']$/g, "")];
  }));
  if (!frontMatter.title || !/^\d{4}-\d{2}-\d{2}$/.test(frontMatter.date ?? "")) {
    throw new Error(`${filename}: title and date (YYYY-MM-DD) are required`);
  }
  return { title: frontMatter.title, date: frontMatter.date, html: markdownToHtml(match[2]) };
}

const PLACEHOLDER_PATTERN = /ダミー|未定|未設定|TBD|TODO|サンプル/i;

// 【ダミー】などの仮の値を公開用データから取り除く。配列内の仮の値は要素ごと除く。
// デプロイ（写真の公開など）を止めずに、仮の案内が公開されるのを防ぐ。
export function maskPlaceholders(value, keyPath = "", masked = []) {
  if (typeof value === "string") {
    if (!PLACEHOLDER_PATTERN.test(value)) return { value, masked };
    masked.push(keyPath);
    return { value: "", masked };
  }
  if (Array.isArray(value)) {
    const items = [];
    value.forEach((item, index) => {
      const itemPath = `${keyPath}[${index}]`;
      if (typeof item === "string" && PLACEHOLDER_PATTERN.test(item)) masked.push(itemPath);
      else items.push(maskPlaceholders(item, itemPath, masked).value);
    });
    return { value: items, masked };
  }
  if (value && typeof value === "object") {
    const output = {};
    for (const [key, child] of Object.entries(value)) {
      output[key] = maskPlaceholders(child, keyPath ? `${keyPath}.${key}` : key, masked).value;
    }
    return { value: output, masked };
  }
  return { value, masked };
}

export function validateEventForPublication(event) {
  const required = [
    "eventName",
    "date",
    "meetingStart",
    "dinnerStart",
    "meetingPlace",
    "meetingMapUrl",
    "dinnerPlace",
    "dinnerAddress",
    "dinnerMapUrl",
    "contactLabel",
    "contactDetails",
    "lateOrAbsentInstructions"
  ];
  const missing = required.filter((key) => typeof event[key] !== "string" || !event[key].trim());
  if (missing.length) throw new Error(`Event details required before publication: ${missing.join(", ")}`);
  if (!Number.isInteger(event.visitorCount) || event.visitorCount < 1) {
    throw new Error("visitorCount must be a positive integer before publication.");
  }
  for (const key of ["meetingMapUrl", "dinnerMapUrl"]) {
    const url = new URL(event[key]);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error(`${key} must use http or https.`);
  }
  if (!Array.isArray(event.groups) || event.groups.length !== 3) {
    throw new Error("Exactly three tour groups must be configured before publication.");
  }
  const groupNames = new Set();
  for (const group of event.groups) {
    if (!group.name?.trim() || !group.leader?.trim() || !Array.isArray(group.members) ||
        !group.members.length || group.members.some((member) => typeof member !== "string" || !member.trim())) {
      throw new Error("Each tour group must have a name, leader, and members before publication.");
    }
    if (groupNames.has(group.name.trim())) throw new Error("Tour group names must be unique.");
    groupNames.add(group.name.trim());
  }
  const memberCount = event.groups.reduce((count, group) => count + group.members.length, 0);
  if (memberCount !== event.visitorCount) {
    throw new Error(`Group member count (${memberCount}) must match visitorCount (${event.visitorCount}).`);
  }
}

async function buildAnnouncements() {
  const directory = path.join(root, "content", "announcements");
  let names = [];
  try {
    names = (await readdir(directory)).filter((name) => name.endsWith(".md"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const items = await Promise.all(names.map(async (name) =>
    ({ name, ...parseAnnouncement(name, await readFile(path.join(directory, name), "utf8")) })));
  items.sort((a, b) => b.date.localeCompare(a.date) || b.name.localeCompare(a.name));
  for (const item of items) delete item.name;
  await writeFile(path.join(generatedRoot, "announcements.json"), `${JSON.stringify(items, null, 2)}\n`);
}

async function buildGallery() {
  let files = [];
  try {
    files = await readdir(sourcePhotos);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  await rm(publicPhotos, { recursive: true, force: true });
  await mkdir(path.join(publicPhotos, "thumbs"), { recursive: true });
  const metadataFiles = files.filter((name) => name.endsWith(".json"));
  const gallery = [];
  let totalBytes = 0;

  for (const metadataName of metadataFiles) {
    const metadata = JSON.parse(await readFile(path.join(sourcePhotos, metadataName), "utf8"));
    const id = metadataName.slice(0, -5);
    if (!/^[a-f0-9-]{36}$/i.test(id) || metadata.id !== id) {
      throw new Error(`${metadataName}: invalid photo id`);
    }
    // 教員（role: "faculty"）の投稿は入学年度を持たない。
    const isFaculty = metadata.role === "faculty";
    if (typeof metadata.name !== "string" || typeof metadata.caption !== "string" ||
        (isFaculty ? metadata.enrollmentYear !== null : !Number.isInteger(metadata.enrollmentYear)) ||
        typeof metadata.decade !== "string") {
      throw new Error(`${metadataName}: required public photo metadata is missing`);
    }
    const imageName = metadata.imageFile;
    if (typeof imageName !== "string" || path.basename(imageName) !== imageName ||
        !imageName.startsWith(`${id}.`) || !validExtensions.has(path.extname(imageName).toLowerCase())) {
      throw new Error(`${metadataName}: invalid imageFile`);
    }
    const sourcePath = path.join(sourcePhotos, imageName);
    const imageStat = await stat(sourcePath);
    totalBytes += imageStat.size;
    if (totalBytes > hardLimit) throw new Error("Approved original photos exceed the 1GB site limit");

    const image = sharp(sourcePath, { limitInputPixels: 40_000_000 });
    const details = await image.metadata();
    if (!["jpeg", "png", "webp"].includes(details.format) || details.exif) {
      throw new Error(`${imageName}: unsupported format or EXIF metadata detected`);
    }
    await mkdir(path.join(publicPhotos, "approved"), { recursive: true });
    await copyFile(sourcePath, path.join(publicPhotos, "approved", imageName));
    const thumbName = `${id}.webp`;
    await image.rotate().resize({ width: 640, height: 640, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 78 }).toFile(path.join(publicPhotos, "thumbs", thumbName));
    gallery.push({
      id,
      name: metadata.name,
      enrollmentYear: metadata.enrollmentYear,
      ...(isFaculty ? { role: "faculty" } : {}),
      decade: metadata.decade,
      caption: metadata.caption,
      createdAt: typeof metadata.createdAt === "string" ? metadata.createdAt : "",
      image: `photos/approved/${imageName}`,
      thumbnail: `photos/thumbs/${thumbName}`
    });
  }

  if (totalBytes > softLimit) console.warn("Warning: approved original photos exceed the 100MB target.");
  // 新着順（承認時の投稿日時の降順）。日時が同じ場合は ID で順序を固定する。
  gallery.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  await writeFile(path.join(generatedRoot, "gallery.json"), `${JSON.stringify(gallery, null, 2)}\n`);
  console.log(`Generated gallery for ${gallery.length} approved photo(s), ${totalBytes} original bytes.`);
}

async function directoryBytes(directory) {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(entryPath);
    else if (entry.isFile()) total += (await stat(entryPath)).size;
  }
  return total;
}

async function main() {
  const sitePath = process.env.SITE_PATH || "local-preview";
  if (!/^[a-z0-9-]{8,64}$/.test(sitePath)) {
    throw new Error("SITE_PATH must be 8-64 lowercase letters, digits, or hyphens.");
  }
  await mkdir(generatedRoot, { recursive: true });
  const event = JSON.parse(await readFile(path.join(root, "content", "event.json"), "utf8"));
  if (process.env.REQUIRE_EVENT_READY === "1") validateEventForPublication(event);
  const { value: publicEvent, masked } = maskPlaceholders(event);
  if (masked.length) {
    const message = `Placeholder (dummy) values were hidden from the published event page: ${masked.join(", ")}`;
    console.warn(process.env.GITHUB_ACTIONS ? `::warning::${message}` : `Warning: ${message}`);
  }
  await writeFile(path.join(generatedRoot, "event.json"), `${JSON.stringify(publicEvent, null, 2)}\n`);
  await buildAnnouncements();
  await buildGallery();
  const siteBytes = await directoryBytes(siteRoot);
  if (siteBytes > hardLimit) throw new Error(`Generated site exceeds the 1GB limit (${siteBytes} bytes)`);
  if (siteBytes > softLimit) console.warn(`Warning: generated site exceeds the 100MB target (${siteBytes} bytes).`);
  await rm(distributionRoot, { recursive: true, force: true });
  const deployDirectory = path.join(distributionRoot, sitePath);
  await mkdir(distributionRoot, { recursive: true });
  await cp(siteRoot, deployDirectory, { recursive: true });
  await copyFile(path.join(siteRoot, "robots.txt"), path.join(distributionRoot, "robots.txt"));
  await writeFile(path.join(distributionRoot, "index.html"), `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8">
    <meta name="robots" content="noindex, nofollow, noarchive">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>ページが見つかりません</title>
  </head>
  <body><p>ページが見つかりません。案内されたURLをご確認ください。</p></body>
</html>
`);
  const deploymentBytes = await directoryBytes(distributionRoot);
  if (deploymentBytes > hardLimit) throw new Error(`Generated Pages deployment exceeds the 1GB limit (${deploymentBytes} bytes)`);
  console.log(`Generated Pages deployment at /${sitePath}/, ${deploymentBytes} bytes.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
