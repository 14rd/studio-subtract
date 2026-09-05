#!/usr/bin/env node
// Syncs the website gallery from the Are.na channel "studio-subtract".
//
// Mirrors the channel into assets/gallery/ (downloads new blocks, deletes
// removed ones, follows channel order) and rewrites the GALLERY_ITEMS array
// in index.html. Files are named by Are.na block id so reordering or deleting
// on Are.na never forces a re-download.
//
// Requires: node >= 18, ffmpeg/ffprobe (for video posters + aspect ratios),
// and ARENA_ACCESS_TOKEN in the environment (the channel is private).
//
// Usage:
//   node sync-arena.mjs          # sync files + index.html, report changes
//   node sync-arena.mjs --push   # also git commit + push (deploys the site)

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const CHANNEL = "studio-subtract";
const ROOT = path.dirname(new URL(import.meta.url).pathname);
const GALLERY = path.join(ROOT, "assets", "gallery");
const INDEX = path.join(ROOT, "index.html");

const TOKEN = process.env.ARENA_ACCESS_TOKEN;
if (!TOKEN) {
  console.error("ARENA_ACCESS_TOKEN is not set. Add it to ~/.zshrc and open a new terminal.");
  process.exit(1);
}

async function api(url) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!res.ok) throw new Error(`Are.na API ${res.status} for ${url}`);
  return res.json();
}

async function fetchChannel() {
  const blocks = [];
  let page = 1;
  while (true) {
    const d = await api(`https://api.are.na/v3/channels/${CHANNEL}/contents?per=100&page=${page}`);
    blocks.push(...d.data);
    if (!d.meta.has_more_pages) break;
    page++;
  }
  return blocks;
}

async function download(url, dest, accept) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers: accept ? { Accept: accept } : {} });
      if (!res.ok) throw new Error(`download ${res.status} for ${url}`);
      fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
      return;
    } catch (err) {
      if (attempt >= 4) throw err;
      console.log(`  retrying (${attempt}/3): ${err.cause?.code || err.message}`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}

function videoRatio(file) {
  const out = execFileSync("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height", "-of", "csv=p=0", file,
  ]).toString().trim();
  const [w, h] = out.split(",").map(Number);
  return +(w / h).toFixed(4);
}

function makePoster(video, poster) {
  execFileSync("ffmpeg", ["-y", "-v", "error", "-i", video, "-frames:v", "1", "-q:v", "3", poster]);
}

const blocks = await fetchChannel();
console.log(`Channel has ${blocks.length} blocks.`);

// Plan the desired gallery state, in channel order.
const items = [];
for (const b of blocks) {
  if (b.type === "Image" && b.image) {
    const gif = b.image.content_type === "image/gif";
    items.push({
      id: b.id,
      file: `${b.id}.${gif ? "gif" : "jpg"}`,
      // gifs need the original to keep animation; otherwise the 1800px jpeg is plenty
      url: gif ? b.image.src : b.image.large.src,
      accept: gif ? undefined : "image/jpeg",
      type: "img",
      r: +(b.image.width / b.image.height).toFixed(4),
      label: b.title || String(b.id),
    });
  } else if (b.type === "Attachment" && b.attachment?.content_type?.startsWith("video/")) {
    items.push({
      id: b.id,
      file: `${b.id}.mp4`,
      url: b.attachment.url,
      type: "video",
      r: null, // measured with ffprobe after download
      label: b.title || String(b.id),
    });
  } else {
    console.log(`skipping unsupported block ${b.id} (${b.type}: ${b.title})`);
  }
}

// Download anything we don't already have.
fs.mkdirSync(GALLERY, { recursive: true });
let added = 0;
for (const it of items) {
  const dest = path.join(GALLERY, it.file);
  if (!fs.existsSync(dest)) {
    console.log(`downloading ${it.file}  (${it.label})`);
    await download(it.url, dest, it.accept);
    added++;
  }
  if (it.type === "video") {
    const poster = path.join(GALLERY, it.file.replace(/\.mp4$/, "_poster.jpg"));
    if (!fs.existsSync(poster)) makePoster(path.join(GALLERY, it.file), poster);
    it.r = videoRatio(path.join(GALLERY, it.file));
  }
}

// Delete gallery files that no longer correspond to a channel block.
const keep = new Set(items.flatMap((it) =>
  it.type === "video" ? [it.file, it.file.replace(/\.mp4$/, "_poster.jpg")] : [it.file]
));
let removed = 0;
for (const f of fs.readdirSync(GALLERY)) {
  if (!keep.has(f)) {
    fs.unlinkSync(path.join(GALLERY, f));
    removed++;
  }
}

// Rewrite the GALLERY_ITEMS array in index.html.
const lines = items.map((it) =>
  `    { src: "assets/gallery/${it.file}", type: "${it.type}", r: ${it.r}, label: ${JSON.stringify(it.label)} },`
);
const html = fs.readFileSync(INDEX, "utf8");
const start = html.indexOf("var GALLERY_ITEMS = [");
const end = html.indexOf("];", start);
if (start === -1 || end === -1) throw new Error("GALLERY_ITEMS array not found in index.html");
const updated =
  html.slice(0, start) + "var GALLERY_ITEMS = [\n" + lines.join("\n") + "\n  " + html.slice(end);
fs.writeFileSync(INDEX, updated);

console.log(`Synced ${items.length} items: ${added} downloaded, ${removed} deleted.`);

if (process.argv.includes("--push")) {
  const git = (...args) => execFileSync("git", args, { cwd: ROOT, stdio: "inherit" });
  git("add", "-A");
  try {
    git("commit", "-m", `Sync gallery from Are.na (${items.length} items)`);
  } catch {
    console.log("Nothing to commit — site already up to date.");
    process.exit(0);
  }
  git("push");
  console.log("Pushed — GitHub Pages will deploy in a minute or two.");
}
