async function loadAnnouncements() {
  const container = document.querySelector("#announcements");
  try {
    const response = await fetch("generated/announcements.json");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const announcements = await response.json();
    container.replaceChildren();
    if (announcements.length === 0) {
      container.innerHTML = '<p class="muted">現在、お知らせはありません。</p>';
      return;
    }
    for (const item of announcements) {
      const article = document.createElement("article");
      article.className = "announcement";
      const date = document.createElement("time");
      date.dateTime = item.date;
      date.textContent = item.date;
      const heading = document.createElement("h3");
      heading.textContent = item.title;
      const body = document.createElement("div");
      body.className = "announcement-body";
      body.innerHTML = item.html;
      article.append(date, heading, body);
      container.append(article);
    }
  } catch (error) {
    container.innerHTML = '<p class="muted">お知らせを読み込めませんでした。時間をおいて再度ご確認ください。</p>';
    console.error("Could not load announcements", error);
  }
}

loadAnnouncements();
