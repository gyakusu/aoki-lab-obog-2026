function text(value, fallback = "未設定") {
  return value?.trim() || fallback;
}

function card(title) {
  const section = document.createElement("section");
  section.className = "card";
  const heading = document.createElement("h2");
  heading.textContent = title;
  section.append(heading);
  return section;
}

function addParagraph(container, label, value, fallback) {
  const paragraph = document.createElement("p");
  const strong = document.createElement("strong");
  strong.textContent = `${label}：`;
  paragraph.append(strong, document.createTextNode(text(value, fallback)));
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

    const basics = card("開催概要");
    const eventDate = new Date(`${event.date}T00:00:00+09:00`);
    const dateLabel = Number.isNaN(eventDate.getTime())
      ? text(event.date, "2026年11月14日（土）")
      : new Intl.DateTimeFormat("ja-JP", { year: "numeric", month: "long", day: "numeric", weekday: "short", timeZone: "Asia/Tokyo" }).format(eventDate);
    addParagraph(basics, "日時", dateLabel);
    addParagraph(basics, "開催エリア", event.area);
    addParagraph(basics, "幹事", (event.organizers ?? []).join("・"));
    root.append(basics);

    const schedule = card("タイムテーブル");
    const list = document.createElement("div");
    list.className = "timeline";
    for (const [time, title] of [[event.meetingStart, "研究室見学"], [event.dinnerStart, "会食"]]) {
      const timeElement = document.createElement("time");
      timeElement.textContent = text(time);
      const activity = document.createElement("span");
      activity.textContent = title;
      list.append(timeElement, activity);
    }
    schedule.append(list);
    root.append(schedule);

    const meeting = card("集合・研究室見学");
    addParagraph(meeting, "集合場所", event.meetingPlace);
    addMapLink(meeting, "地図", event.meetingMapUrl);
    root.append(meeting);

    const groups = card("見学グループ");
    const groupIntro = document.createElement("p");
    groupIntro.textContent = event.visitorCount
      ? `${event.visitorCount}名を3グループに分けて見学します。`
      : "3グループに分けて見学します。";
    groups.append(groupIntro);
    const groupList = document.createElement("ul");
    for (const group of event.groups ?? []) {
      const item = document.createElement("li");
      const members = group.members?.length ? group.members.join("、") : "メンバー未設定";
      item.textContent = `${text(group.name)} — 引率：${text(group.leader)} — ${members}`;
      groupList.append(item);
    }
    groups.append(groupList);
    root.append(groups);

    const dinner = card("会食");
    addParagraph(dinner, "会場", event.dinnerPlace);
    addParagraph(dinner, "住所", event.dinnerAddress);
    addMapLink(dinner, "地図", event.dinnerMapUrl);
    root.append(dinner);

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
