function text(value, fallback = "未設定") {
  if (value === null || value === undefined) return fallback;
  return String(value).trim() || fallback;
}

const EMAIL_IN_TEXT = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

// 文中のメールアドレスをタップで送信できるリンクにする（innerHTML は使わない）。
function appendLinkedText(container, value) {
  let lastIndex = 0;
  for (const match of value.matchAll(EMAIL_IN_TEXT)) {
    container.append(document.createTextNode(value.slice(lastIndex, match.index)));
    const link = document.createElement("a");
    link.href = `mailto:${match[0]}`;
    link.textContent = match[0];
    container.append(link);
    lastIndex = match.index + match[0].length;
  }
  container.append(document.createTextNode(value.slice(lastIndex)));
}

function card(title, span = "span-6") {
  const section = document.createElement("section");
  section.className = `card ${span}`;
  const heading = document.createElement("h2");
  heading.textContent = title;
  section.append(heading);
  return section;
}

function addParagraph(container, label, value, fallback) {
  const paragraph = document.createElement("p");
  const strong = document.createElement("strong");
  strong.textContent = `${label}：`;
  paragraph.append(strong);
  appendLinkedText(paragraph, text(value, fallback));
  container.append(paragraph);
}

function addMapLink(container, label, url) {
  const paragraph = document.createElement("p");
  const strong = document.createElement("strong");
  strong.textContent = `${label}：`;
  paragraph.append(strong);
  try {
    const mapUrl = new URL(url);
    if (!["https:", "http:"].includes(mapUrl.protocol)) throw new Error("Unsupported map URL");
    const link = document.createElement("a");
    link.href = mapUrl.href;
    link.rel = "noopener noreferrer";
    link.target = "_blank";
    link.textContent = "地図を開く（新しいタブ）";
    paragraph.append(link);
  } catch {
    paragraph.append(document.createTextNode("未設定"));
  }
  container.append(paragraph);
}

async function loadEvent() {
  const root = document.querySelector("#event-details");
  try {
    const response = await fetch("generated/event.json");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const event = await response.json();
    root.replaceChildren();

    const basics = card("開催概要", "span-3");
    const eventDate = new Date(`${event.date}T00:00:00+09:00`);
    const dateLabel = Number.isNaN(eventDate.getTime())
      ? text(event.date, "2026年11月14日（土）")
      : new Intl.DateTimeFormat("ja-JP", { year: "numeric", month: "long", day: "numeric", weekday: "short", timeZone: "Asia/Tokyo" }).format(eventDate);
    addParagraph(basics, "日時", dateLabel);
    addParagraph(basics, "開催エリア", event.area);
    addParagraph(basics, "幹事", (event.organizers ?? []).join("・"));
    root.append(basics);

    const schedule = card("タイムテーブル", "span-3");
    const list = document.createElement("div");
    list.className = "timeline";
    const dinnerTime = event.dinnerEnd ? `${event.dinnerStart}〜${event.dinnerEnd}` : event.dinnerStart;
    for (const [time, title] of [[event.meetingStart, "研究室見学"], [dinnerTime, "会食"]]) {
      const timeElement = document.createElement("time");
      timeElement.textContent = text(time);
      const activity = document.createElement("span");
      activity.textContent = title;
      list.append(timeElement, activity);
    }
    schedule.append(list);
    root.append(schedule);

    const meeting = card("集合・研究室見学", "span-3");
    addParagraph(meeting, "集合場所", event.meetingPlace);
    addMapLink(meeting, "地図", event.meetingMapUrl);
    root.append(meeting);

    if (Array.isArray(event.rooms) && event.rooms.length) {
      const rooms = card("見学する部屋と担当学生", "span-3");
      const roomList = document.createElement("ul");
      for (const room of event.rooms) {
        const item = document.createElement("li");
        item.textContent = `${text(room.name)} — 担当：${text(room.guide)}`;
        roomList.append(item);
      }
      rooms.append(roomList);
      const roomNote = document.createElement("p");
      roomNote.textContent = "担当学生は各部屋で待機して説明します。各グループは同じ順番で部屋を巡回します。各部屋20分程度です。";
      rooms.append(roomNote);
      root.append(rooms);
    }

    const dinner = card("会食", "span-3");
    addParagraph(dinner, "時間", dinnerTime);
    addParagraph(dinner, "会場", event.dinnerPlace);
    addParagraph(dinner, "住所", event.dinnerAddress);
    addMapLink(dinner, "地図", event.dinnerMapUrl);
    root.append(dinner);

    const groups = card("見学グループ");
    const groupIntro = document.createElement("p");
    const groupCount = (event.groups ?? []).length;
    groupIntro.textContent = event.visitorCount && groupCount
      ? `${event.visitorCount}名を${groupCount}グループに分けて見学します。`
      : "グループに分けて見学します。";
    groups.append(groupIntro);
    const groupList = document.createElement("ul");
    for (const group of event.groups ?? []) {
      const item = document.createElement("li");
      const members = group.members?.length ? group.members.join("、") : "メンバー未設定";
      item.textContent = `${text(group.name)} — 担当：${text(group.leader)} — ${members}`;
      groupList.append(item);
    }
    groups.append(groupList);
    if (Array.isArray(event.tourRotation) && event.tourRotation.length) {
      const routeTitle = document.createElement("p");
      routeTitle.textContent = "巡回順（グループごとに開始する部屋が異なります）";
      groups.append(routeTitle);
      const routeList = document.createElement("ul");
      for (const entry of event.tourRotation) {
        const item = document.createElement("li");
        item.textContent = `${text(entry.group)}：${(entry.route ?? []).map(text).join(" → ")}`;
        routeList.append(item);
      }
      groups.append(routeList);
    }
    root.append(groups);

    const contact = card("遅刻・欠席・お問い合わせ");
    addParagraph(contact, "連絡先", event.contactLabel);
    addParagraph(contact, "連絡方法", event.contactDetails);
    addParagraph(contact, "遅刻・欠席時", event.lateOrAbsentInstructions);
    const privacy = document.createElement("p");
    privacy.className = "hint";
    privacy.textContent = "写真の削除依頼も上記の幹事連絡先へお願いします。メールアドレス等の参加者情報は掲載していません。";
    contact.append(privacy);
    root.append(contact);
  } catch (error) {
    root.innerHTML = '<p class="muted">当日案内を読み込めませんでした。時間をおいて再度ご確認ください。</p>';
    console.error("Could not load event details", error);
  }
}

loadEvent();
