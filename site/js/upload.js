import { UPLOAD_API_URL } from "../config.js";

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_FILES = 3;
const MAX_DIMENSION = 1600;
const acceptedTypes = new Set(["image/jpeg", "image/png", "image/webp"]);

function setStatus(message, kind = "") {
  const status = document.querySelector("#upload-status");
  status.textContent = message;
  status.dataset.kind = kind;
}

function encodeCanvas(canvas, type, quality) {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), type, quality);
  });
}

function drawToCanvas(image, width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas;
}

async function compressImage(image, originalType) {
  const initialRatio = Math.min(1, MAX_DIMENSION / Math.max(image.naturalWidth, image.naturalHeight));
  let width = image.naturalWidth * initialRatio;
  let height = image.naturalHeight * initialRatio;
  // First keep the original format (PNG stays PNG) while it fits the limit.
  const firstCanvas = drawToCanvas(image, width, height);
  if (!firstCanvas) return null;
  let blob = await encodeCanvas(firstCanvas, originalType);
  if (blob && blob.size <= MAX_FILE_BYTES) return blob;
  // Otherwise re-encode as JPEG, lowering quality and then dimensions
  // until the result fits the per-file limit.
  for (let step = 0; step < 4; step += 1) {
    const canvas = drawToCanvas(image, width, height);
    if (!canvas) return null;
    for (const quality of [0.85, 0.72, 0.6, 0.48]) {
      blob = await encodeCanvas(canvas, "image/jpeg", quality);
      if (blob && blob.size <= MAX_FILE_BYTES) return blob;
    }
    width *= 0.75;
    height *= 0.75;
  }
  return blob;
}

function resizeImage(file) {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const image = new Image();
    image.onload = async () => {
      URL.revokeObjectURL(objectUrl);
      try {
        const blob = await compressImage(image, file.type);
        if (!blob) {
          reject(new Error("画像を処理できませんでした。"));
          return;
        }
        if (!acceptedTypes.has(blob.type)) {
          reject(new Error("このブラウザでは画像を処理できませんでした。"));
          return;
        }
        const name = blob.type === file.type
          ? file.name
          : file.name.replace(/\.[^.]+$/, "") + (blob.type === "image/jpeg" ? ".jpg" : blob.type === "image/webp" ? ".webp" : ".png");
        resolve(new File([blob], name, { type: blob.type, lastModified: Date.now() }));
      } catch (error) {
        reject(error instanceof Error ? error : new Error("画像を処理できませんでした。"));
      }
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error(`${file.name}: 画像を読み込めませんでした。`));
    };
    image.src = objectUrl;
  });
}

function fileSelectionError(files) {
  if (files.length < 1 || files.length > MAX_FILES) return `写真は1回につき1〜${MAX_FILES}枚選択してください（現在${files.length}枚）。`;
  const unsupported = files.find((file) => !acceptedTypes.has(file.type));
  if (unsupported) return `${unsupported.name}: JPEG、PNG、WebP 形式の画像を選択してください。`;
  return "";
}

let previewUrls = [];

function renderPreview(files) {
  const preview = document.querySelector("#photo-preview");
  for (const url of previewUrls) URL.revokeObjectURL(url);
  previewUrls = [];
  preview.replaceChildren();
  for (const file of files.slice(0, MAX_FILES)) {
    if (!acceptedTypes.has(file.type)) continue;
    const image = document.createElement("img");
    image.src = URL.createObjectURL(file);
    image.alt = file.name;
    previewUrls.push(image.src);
    preview.append(image);
  }
}

// 教員（青木先生）には入学年度がないため、入力欄を隠して必須から外す。
const roleSelect = document.querySelector('#upload-form select[name="role"]');
function updateEnrollmentYearField() {
  const isFaculty = roleSelect.value === "faculty";
  const yearInput = document.querySelector('#upload-form input[name="enrollmentYear"]');
  document.querySelector("#enrollment-year-field").hidden = isFaculty;
  yearInput.required = !isFaculty;
  yearInput.disabled = isFaculty;
}
roleSelect.addEventListener("change", updateEnrollmentYearField);
updateEnrollmentYearField();

const photoInput = document.querySelector('#upload-form input[name="photos"]');
photoInput.addEventListener("change", () => {
  const files = [...photoInput.files];
  renderPreview(files);
  const error = files.length ? fileSelectionError(files) : "";
  setStatus(error || (files.length ? `${files.length}枚を選択しました。` : ""), error ? "error" : "");
});

document.querySelector("#upload-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const files = [...form.elements.photos.files];
  if (!UPLOAD_API_URL) {
    setStatus("投稿受付の設定がまだ完了していません。幹事へお問い合わせください。", "error");
    return;
  }
  const selectionError = fileSelectionError(files);
  if (selectionError) {
    setStatus(selectionError, "error");
    return;
  }

  const submitButton = form.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  setStatus("画像を圧縮して送信しています。画面を閉じずにお待ちください。");
  try {
    const normalized = await Promise.all(files.map(resizeImage));
    if (normalized.some((file) => file.size > MAX_FILE_BYTES)) {
      throw new Error("圧縮しても5MBに収まらない写真がありました。別の写真をお選びください。");
    }
    const formData = new FormData(form);
    formData.delete("photos");
    normalized.forEach((file) => formData.append("photos", file, file.name));
    let response;
    try {
      response = await fetch(`${UPLOAD_API_URL.replace(/\/$/, "")}/api/upload`, {
        method: "POST",
        body: formData
      });
    } catch {
      // fetch の失敗はブラウザごとに英語のメッセージ（Failed to fetch など）になるため置き換える。
      throw new Error("通信できませんでした。電波の良い場所で、もう一度送信してください。");
    }
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `送信に失敗しました（${response.status}）。時間をおいて再度お試しください。`);
    // 続けて投稿しやすいよう、立場・投稿者名・入学年度・撮影時期は残し、写真とキャプションだけ消す。
    form.elements.photos.value = "";
    form.elements.caption.value = "";
    renderPreview([]);
    setStatus(`${result.accepted ?? normalized.length}枚の投稿を受け付けました。幹事の確認後、ギャラリーに掲載されます。続けて別の写真も投稿できます。`, "success");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "送信に失敗しました。時間をおいて再度お試しください。", "error");
  } finally {
    submitButton.disabled = false;
  }
});
