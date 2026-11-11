let photos = [];

// 撮影時期は「2012年」のような年、「2010年代」のような年代、「年代不明」のいずれか。
function decadeOf(period) {
  const match = /^(\d{3})\d年/.exec(period);
  return match ? `${match[1]}0年代` : period;
}

function matchesPeriod(photo, filter) {
  if (!filter) return true;
  return filter.startsWith("decade:") ? decadeOf(photo.decade) === filter.slice(7) : photo.decade === filter;
}

function contributorKey(photo) {
  return photo.role === "faculty" ? "faculty" : String(photo.enrollmentYear);
}

function contributorLabel(photo) {
  return photo.role === "faculty" ? "教員" : `${photo.enrollmentYear}年入学`;
}

function filteredPhotos() {
  const period = document.querySelector("#decade-filter").value;
  const year = document.querySelector("#year-filter").value;
  return photos.filter((photo) => matchesPeriod(photo, period) && (!year || contributorKey(photo) === year));
}

function renderGallery() {
  const root = document.querySelector("#gallery");
  const filtered = filteredPhotos();
  document.querySelector("#slideshow-start").disabled = filtered.length === 0;
  root.replaceChildren();
  if (filtered.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = photos.length ? "条件に合う写真がありません。" : "掲載中の写真はありません。";
    root.append(empty);
    return;
  }
  for (const photo of filtered) {
    const button = document.createElement("button");
    button.className = "photo-card";
    button.type = "button";
    button.setAttribute("aria-label", `${photo.caption}、${contributorLabel(photo)}`);
    const image = document.createElement("img");
    image.src = photo.thumbnail;
    image.alt = photo.caption;
    image.loading = "lazy";
    const caption = document.createElement("span");
    caption.className = "photo-caption";
    const title = document.createElement("strong");
    title.textContent = photo.caption;
    const details = document.createElement("span");
    details.textContent = `${photo.decade}・${contributorLabel(photo)}・${photo.name}`;
    caption.append(title, details);
    button.append(image, caption);
    button.addEventListener("click", () => openPhoto(photo));
    root.append(button);
  }
}

function openPhoto(photo) {
  const dialog = document.querySelector("#photo-dialog");
  const image = document.querySelector("#dialog-image");
  // 前に開いた写真が一瞬表示されないよう、読み込み前に消しておく。
  image.removeAttribute("src");
  image.src = photo.image;
  image.alt = photo.caption;
  document.querySelector("#dialog-caption").textContent = `${photo.caption} — ${photo.name}（${contributorLabel(photo)}・${photo.decade}）`;
  dialog.showModal();
}

async function loadGallery() {
  try {
    const response = await fetch("generated/gallery.json");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    photos = await response.json();
    // 撮影時期は年代ごとに「年代全体」と、写真のある個別の年を並べる。
    const periodFilter = document.querySelector("#decade-filter");
    const periods = [...new Set(photos.map((photo) => photo.decade))];
    const decades = [...new Set(periods.map(decadeOf))].filter((value) => value !== "年代不明").sort();
    for (const decade of decades) {
      const group = document.createElement("optgroup");
      group.label = decade;
      group.append(new Option(`${decade}（すべて）`, `decade:${decade}`));
      for (const period of periods.filter((value) => value !== decade && decadeOf(value) === decade).sort()) {
        group.append(new Option(period, period));
      }
      periodFilter.append(group);
    }
    if (periods.includes("年代不明")) periodFilter.append(new Option("年代不明", "年代不明"));

    const yearFilter = document.querySelector("#year-filter");
    if (photos.some((photo) => photo.role === "faculty")) yearFilter.append(new Option("教員", "faculty"));
    const years = [...new Set(photos.filter((photo) => photo.role !== "faculty").map((photo) => String(photo.enrollmentYear)))]
      .sort((a, b) => Number(a) - Number(b));
    for (const value of years) yearFilter.append(new Option(`${value}年入学`, value));
    renderGallery();
  } catch (error) {
    document.querySelector("#gallery").textContent = "ギャラリーを読み込めませんでした。時間をおいて再度ご確認ください。";
    console.error("Could not load gallery", error);
  }
}

document.querySelector("#decade-filter").addEventListener("change", renderGallery);
document.querySelector("#year-filter").addEventListener("change", renderGallery);
document.querySelector("#dialog-close").addEventListener("click", () => document.querySelector("#photo-dialog").close());
document.querySelector("#photo-dialog").addEventListener("click", (event) => {
  if (event.target === event.currentTarget) event.currentTarget.close();
});
// ---------- スライドショー（プロジェクタ投影用） ----------
// 1920x1080 の固定ステージを全画面で表示し、シャッフルした順番で一定間隔ごとに写真を送る。
const slideshow = {
  queue: [],
  index: -1,
  layer: 0,
  paused: false,
  timer: 0,
  startedAt: 0,
  remaining: 0,
  frame: 0,
  idleTimer: 0,
  wakeLock: null
};

// Fisher-Yates シャッフル。一周して並べ直すとき、直前の写真が先頭に来て連続しないようにする。
function shuffle(items, avoidFirst) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  if (avoidFirst && result.length > 1 && result[0] === avoidFirst) {
    const swap = 1 + Math.floor(Math.random() * (result.length - 1));
    [result[0], result[swap]] = [result[swap], result[0]];
  }
  return result;
}

function slideInterval() {
  return Number(document.querySelector("#slideshow-interval").value) * 1000;
}

function fitStage() {
  const scale = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
  document.querySelector("#slideshow-stage").style.setProperty("--slide-scale", String(scale));
}

function preload(photo) {
  if (!photo) return;
  const image = new Image();
  image.src = photo.image;
}

function showSlide(step) {
  const { queue } = slideshow;
  let next = slideshow.index + step;
  if (next >= queue.length) {
    slideshow.queue = shuffle(queue, queue[queue.length - 1]);
    next = 0;
  } else if (next < 0) {
    next = queue.length - 1;
  }
  slideshow.index = next;
  const photo = slideshow.queue[next];

  const layers = document.querySelectorAll("#slideshow .slide-layer");
  slideshow.layer = 1 - slideshow.layer;
  const incoming = layers[slideshow.layer];
  const outgoing = layers[1 - slideshow.layer];
  const image = incoming.querySelector(".slide-image");
  const reveal = () => {
    // 読み込み完了後にフェードさせ、ズームのアニメーションも頭から再生する。
    incoming.classList.remove("active");
    void incoming.offsetWidth;
    incoming.classList.add("active");
    outgoing.classList.remove("active");
  };
  image.onload = reveal;
  image.onerror = reveal;
  image.src = photo.image;
  image.alt = photo.caption;
  // キャッシュ済み（同じ写真の再表示を含む）なら load を待たずに表示する。
  if (image.complete) {
    image.onload = null;
    image.onerror = null;
    reveal();
  }
  incoming.querySelector(".slide-backdrop").style.backgroundImage = `url("${photo.thumbnail}")`;

  const info = document.querySelector("#slideshow .slide-info");
  document.querySelector("#slide-caption").textContent = photo.caption;
  document.querySelector("#slide-name").textContent = photo.name;
  document.querySelector("#slide-contributor").textContent = contributorLabel(photo);
  document.querySelector("#slide-period").textContent = photo.decade ? `撮影: ${photo.decade}` : "";
  document.querySelector("#slide-counter").textContent = `${next + 1} / ${queue.length}`;
  info.classList.remove("show");
  void info.offsetWidth;
  info.classList.add("show");

  preload(slideshow.queue[next + 1]);
  restartTimer();
}

function tickProgress() {
  const elapsed = slideshow.paused ? 0 : performance.now() - slideshow.startedAt;
  const total = slideInterval();
  const done = total - slideshow.remaining + elapsed;
  document.querySelector("#slide-progress-bar").style.width = `${Math.min(100, (done / total) * 100)}%`;
  slideshow.frame = requestAnimationFrame(tickProgress);
}

function scheduleAdvance(delay) {
  clearTimeout(slideshow.timer);
  slideshow.remaining = delay;
  slideshow.startedAt = performance.now();
  if (!slideshow.paused) slideshow.timer = setTimeout(() => showSlide(1), delay);
}

function restartTimer() {
  const duration = slideInterval();
  document.querySelector("#slideshow").style.setProperty("--slide-duration", `${duration / 1000 + 1.2}s`);
  scheduleAdvance(duration);
}

function setPaused(paused) {
  if (paused === slideshow.paused) return;
  if (paused) {
    clearTimeout(slideshow.timer);
    slideshow.remaining = Math.max(0, slideshow.remaining - (performance.now() - slideshow.startedAt));
  }
  slideshow.paused = paused;
  document.querySelector("#slide-paused").hidden = !paused;
  document.querySelector("#slideshow-toggle").textContent = paused ? "▶" : "❚❚";
  document.querySelector("#slideshow").classList.toggle("paused", paused);
  if (!paused) scheduleAdvance(slideshow.remaining);
}

function wakeControls() {
  const root = document.querySelector("#slideshow");
  root.classList.remove("idle");
  clearTimeout(slideshow.idleTimer);
  slideshow.idleTimer = setTimeout(() => root.classList.add("idle"), 2500);
}

async function requestWakeLock() {
  try {
    slideshow.wakeLock = await navigator.wakeLock?.request("screen");
  } catch {
    // 省電力設定などで取得できない場合は、そのまま続ける。
  }
}

async function startSlideshow() {
  const list = filteredPhotos();
  if (list.length === 0) return;
  const root = document.querySelector("#slideshow");
  slideshow.queue = shuffle(list);
  slideshow.index = -1;
  slideshow.paused = false;
  document.querySelector("#slide-paused").hidden = true;
  document.querySelector("#slideshow-toggle").textContent = "❚❚";
  for (const layer of root.querySelectorAll(".slide-layer")) layer.classList.remove("active");
  root.hidden = false;
  document.body.style.overflow = "hidden";
  fitStage();
  try {
    await root.requestFullscreen?.({ navigationUI: "hide" });
  } catch {
    // 全画面が拒否されてもウィンドウ全体に表示して続ける。
  }
  requestWakeLock();
  showSlide(1);
  cancelAnimationFrame(slideshow.frame);
  slideshow.frame = requestAnimationFrame(tickProgress);
  wakeControls();
}

function stopSlideshow() {
  const root = document.querySelector("#slideshow");
  if (root.hidden) return;
  clearTimeout(slideshow.timer);
  clearTimeout(slideshow.idleTimer);
  cancelAnimationFrame(slideshow.frame);
  slideshow.wakeLock?.release().catch(() => {});
  slideshow.wakeLock = null;
  root.hidden = true;
  root.classList.remove("idle");
  document.body.style.overflow = "";
  for (const image of root.querySelectorAll(".slide-image")) image.removeAttribute("src");
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  document.querySelector("#slideshow-start").focus();
}

document.querySelector("#slideshow-start").addEventListener("click", startSlideshow);
document.querySelector("#slideshow .slideshow-controls").addEventListener("click", (event) => {
  const action = event.target.closest("button")?.dataset.action;
  if (action === "prev") showSlide(-1);
  else if (action === "next") showSlide(1);
  else if (action === "toggle") setPaused(!slideshow.paused);
  else if (action === "close") stopSlideshow();
});
document.querySelector("#slideshow-interval").addEventListener("change", () => {
  if (!slideshow.paused) restartTimer();
  else slideshow.remaining = slideInterval();
});
document.querySelector("#slideshow-stage").addEventListener("click", () => setPaused(!slideshow.paused));
document.querySelector("#slideshow").addEventListener("pointermove", wakeControls);
document.addEventListener("keydown", (event) => {
  if (document.querySelector("#slideshow").hidden || event.target.closest?.("select")) return;
  if (event.key === "Escape") stopSlideshow();
  else if (event.key === "ArrowRight" || event.key === "PageDown") showSlide(1);
  else if (event.key === "ArrowLeft" || event.key === "PageUp") showSlide(-1);
  else if (event.key === " " || event.key === "k") setPaused(!slideshow.paused);
  else return;
  event.preventDefault();
});
// ブラウザの操作（Esc など）で全画面が解除されたら、スライドショーも終了する。
document.addEventListener("fullscreenchange", () => {
  if (!document.fullscreenElement) stopSlideshow();
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && !document.querySelector("#slideshow").hidden) requestWakeLock();
});
window.addEventListener("resize", fitStage);
loadGallery();
