import multer from "multer";

export function imageUpload(fields: number, files = 1) {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024, files, fields, fieldSize: 12 * 1024 },
  });
  return files === 1 ? upload.single("image") : upload.array("image", files);
}

export class ImageUploadError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

function imageMime(bytes: Buffer) {
  if (bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return "image/jpeg";
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP") return "image/webp";
}

export async function uploadImage(file: Express.Multer.File) {
  const mime = imageMime(file.buffer);
  if (!mime) throw new ImageUploadError(400, "Choose a JPEG, PNG, or WebP image.");
  const key = process.env.IMGBB_API_KEY?.trim();
  if (!key) throw new ImageUploadError(503, "Image uploads are unavailable. You can continue without a new photo.");

  try {
    const body = new FormData();
    body.set("image", new Blob([Uint8Array.from(file.buffer)], { type: mime }), "wedplan." + mime.split("/")[1]);
    const url = new URL("https://api.imgbb.com/1/upload");
    url.searchParams.set("key", key);
    const response = await fetch(url, { method: "POST", body, redirect: "error", signal: AbortSignal.timeout(15_000) });
    const result = await response.json();
    if (!response.ok || result.success !== true || typeof result.data?.url !== "string") throw new Error();
    const hosted = new URL(result.data.url);
    if (hosted.protocol !== "https:" || hosted.hostname !== "i.ibb.co") throw new Error();
    return hosted.href;
  } catch {
    throw new ImageUploadError(502, "The image could not be uploaded. Try again or continue without a new photo.");
  }
}
