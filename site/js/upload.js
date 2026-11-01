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

function resizeImage(file) {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(objectUrl);
      const ratio = Math.min(1, MAX_DIMENSION / Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.naturalWidth * ratio));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * ratio));
      const context = canvas.getContext("2d");
      if (!context) {
        reject(new Error("画像を処理できませんでした。"));
        return;
      }
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((blob) => {
        if (!blob) {
          reject(new Error("画像を再エンコードできませんでした。"));
          return;
        }
        if (!acceptedTypes.has(blob.type)) {
          reject(new Error("このブラウザでは画像を処理できませんでした。"));
          return;
        }
        resolve(new File([blob], file.name, { type: blob.type, lastModified: Date.now() }));
      }, file.type);
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error(`${file.name}: 画像を読み込めませんでした。`));
    };
    image.src = objectUrl;
  });
}

document.querySelector("#upload-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const files = [...form.elements.photos.files];
  if (!UPLOAD_API_URL) {
    setStatus("投稿受付の設定がまだ完了していません。幹事へお問い合わせください。", "error");
    return;
  }
  if (files.length < 1 || files.length > MAX_FILES) {
    setStatus("写真は1回につき1〜3枚選択してください。", "error");
    return;
  }
  for (const file of files) {
    if (!acceptedTypes.has(file.type)) {
      setStatus("JPEG、PNG、WebP 形式の画像を選択してください。", "error");
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setStatus("1枚あたりの上限は5MBです。", "error");
      return;
    }
  }

  const submitButton = form.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  setStatus("画像を縮小して送信しています。画面を閉じずにお待ちください。");
  try {
    const normalized = await Promise.all(files.map(resizeImage));
    if (normalized.some((file) => file.size > MAX_FILE_BYTES)) {
      throw new Error("縮小後も5MBを超える写真があります。別の写真をお選びください。");
    }
    const formData = new FormData(form);
    formData.delete("photos");
    normalized.forEach((file) => formData.append("photos", file, file.name));
    const response = await fetch(`${UPLOAD_API_URL.replace(/\/$/, "")}/api/upload`, {
      method: "POST",
      body: formData
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `送信に失敗しました（${response.status}）。`);
    form.reset();
    setStatus("投稿を受け付けました。幹事の確認後、承認された写真がギャラリーに掲載されます。", "success");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "送信に失敗しました。時間をおいて再度お試しください。", "error");
  } finally {
    submitButton.disabled = false;
  }
});
