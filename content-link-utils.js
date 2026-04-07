export const CATEGORY_ALIASES = Object.freeze({
  media: "video",
  docs: "document"
});

export const TRUSTED_EXTERNAL_URL_HOSTS = Object.freeze([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "youtu.be",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com"
]);

function normalizeSlugValue(value) {
  const input = String(value ?? "");
  const normalized = typeof input.normalize === "function"
    ? input.normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    : input;

  return normalized
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 64);
}

function makeRandomSuffix(length = 6) {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";

  if (globalThis.crypto?.getRandomValues) {
    const values = new Uint8Array(length);
    globalThis.crypto.getRandomValues(values);
    return Array.from(values, (value) => alphabet[value % alphabet.length]).join("");
  }

  return Math.random().toString(36).slice(2, 2 + length).padEnd(length, "0");
}

export function normalizeCategory(category) {
  const normalized = String(category || "").trim().toLowerCase();
  return CATEGORY_ALIASES[normalized] || normalized || "other";
}

export function sanitizeShareSlug(value, fallback = "item") {
  return normalizeSlugValue(value) || fallback;
}

export function createShareSlug(label, fallback = "item") {
  return `${sanitizeShareSlug(label, fallback)}-${makeRandomSuffix(6)}`;
}

export function getItemShareSlug(item) {
  if (item?.shareSlug) {
    return sanitizeShareSlug(item.shareSlug, "item");
  }

  const base = sanitizeShareSlug(item?.title || "item", "item");
  const idPart = String(item?.id || "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toLowerCase()
    .slice(0, 8);

  return idPart ? `${base}-${idPart}` : base;
}

export function getFileShareSlug(item, file, index = 0) {
  if (file?.shareSlug) {
    return sanitizeShareSlug(file.shareSlug, "file");
  }

  const base = sanitizeShareSlug(file?.name || "file", "file");
  const backendId = String(file?.backendScan?.id || "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toLowerCase()
    .slice(0, 8);
  const itemId = String(item?.id || "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toLowerCase()
    .slice(0, 8);
  const fallbackId = backendId || itemId || String(index + 1);

  return `${base}-${fallbackId}`;
}

export function isTrustedExternalUrl(url) {
  try {
    const parsed = new URL(url);
    return TRUSTED_EXTERNAL_URL_HOSTS.some((host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`));
  } catch {
    return false;
  }
}

export function getYouTubeId(rawUrl) {
  const value = String(rawUrl || "").trim();
  if (!value) return null;

  try {
    const parsed = new URL(value);
    const hostname = parsed.hostname.toLowerCase();

    if (hostname === "youtu.be") {
      const shortId = parsed.pathname.split("/").filter(Boolean)[0];
      return shortId?.length === 11 ? shortId : null;
    }

    if (hostname.includes("youtube.com") || hostname.includes("youtube-nocookie.com")) {
      const watchId = parsed.searchParams.get("v");
      if (watchId?.length === 11) return watchId;

      const pathSegments = parsed.pathname.split("/").filter(Boolean);
      const candidate = pathSegments.find((segment, index) => {
        const prev = pathSegments[index - 1];
        return ["embed", "shorts", "live", "v"].includes(prev || "");
      });

      return candidate?.length === 11 ? candidate : null;
    }
  } catch {
    const regex = /^.*(youtu\.be\/|v\/|u\/\w\/|embed\/|shorts\/|watch\?v=|&v=)([^#&?]{11}).*/;
    const match = value.match(regex);
    if (match?.[2]) return match[2];
  }

  return null;
}

export function getEmbeddableVideoMeta(fileOrUrl) {
  const url = typeof fileOrUrl === "string" ? fileOrUrl : fileOrUrl?.url;
  const videoId = getYouTubeId(url);
  if (!videoId) return null;

  return {
    provider: "youtube",
    videoId,
    watchUrl: `https://www.youtube.com/watch?v=${videoId}`,
    embedUrl: `https://www.youtube.com/embed/${videoId}?autoplay=1&rel=0`,
    thumbnailUrl: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`
  };
}

export function getPrimaryEmbeddableVideo(item) {
  const files = Array.isArray(item?.files) ? item.files : [];

  for (let index = 0; index < files.length; index++) {
    const file = files[index];
    const video = getEmbeddableVideoMeta(file);
    if (video) {
      return {
        ...video,
        file,
        index,
        shareSlug: getFileShareSlug(item, file, index)
      };
    }
  }

  return null;
}

export function buildItemShareHash(itemSlug) {
  return `#/item/${encodeURIComponent(itemSlug)}`;
}

export function buildFileShareHash(itemSlug, fileSlug) {
  return `#/watch/${encodeURIComponent(itemSlug)}/${encodeURIComponent(fileSlug)}`;
}

export function buildShareUrl(baseUrl, hash) {
  return `${String(baseUrl || "").replace(/#.*$/, "")}${hash}`;
}
