let photos = [];

function renderGallery() {
  const root = document.querySelector("#gallery");
  const decade = document.querySelector("#decade-filter").value;
  const year = document.querySelector("#year-filter").value;
  const filtered = photos.filter((photo) => (!decade || photo.decade === decade) && (!year || String(photo.enrollmentYear) === year));
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
    button.setAttribute("aria-label", `${photo.caption}、${photo.enrollmentYear}年入学`);
    const image = document.createElement("img");
    image.src = photo.thumbnail;
    image.alt = photo.caption;
    image.loading = "lazy";
    const caption = document.createElement("span");
    caption.className = "photo-caption";
    const title = document.createElement("strong");
    title.textContent = photo.caption;
    const details = document.createElement("span");
    details.textContent = `${photo.decade}・${photo.enrollmentYear}年入学・${photo.name}`;
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
  document.querySelector("#dialog-caption").textContent = `${photo.caption} — ${photo.name}（${photo.enrollmentYear}年入学・${photo.decade}）`;
  dialog.showModal();
}

async function loadGallery() {
  try {
    const response = await fetch("generated/gallery.json");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    photos = await response.json();
    const decades = [...new Set(photos.map((photo) => photo.decade))].sort();
    const years = [...new Set(photos.map((photo) => String(photo.enrollmentYear)))].sort((a, b) => Number(a) - Number(b));
    for (const [selector, values] of [["#decade-filter", decades], ["#year-filter", years]]) {
      const select = document.querySelector(selector);
      for (const value of values) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = selector === "#year-filter" ? `${value}年入学` : value;
        select.append(option);
      }
    }
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
loadGallery();
