const DEFAULT_UPLOAD_URL = "https://upload.gofile.io/uploadfile";

function resolveGofileUploadUrl() {
    if (typeof __gofile_upload_url !== 'undefined' && __gofile_upload_url) {
        return __gofile_upload_url;
    }

    return DEFAULT_UPLOAD_URL;
}

function resolveGofileApiToken() {
    if (typeof __gofile_api_token !== 'undefined' && __gofile_api_token) {
        return __gofile_api_token;
    }

    return "";
}

function normalizePayloadResponse(payload = {}) {
    const data = payload?.data || payload || {};
    const code = data.code || data.id || data.fileId || data.contentId || "";
    const downloadPage = data.downloadPage || data.downloadpage || (code ? `https://gofile.io/d/${code}` : "");
    const directUrl = data.directLink || data.directlink || data.link || "";
    const url = directUrl || downloadPage;

    return {
        ok: Boolean(url),
        url,
        directUrl,
        downloadPage,
        code,
        fileId: data.fileId || data.id || data.contentId || "",
        folderId: data.parentFolder || data.folderId || data.parentFolderId || "",
        guestToken: data.guestToken || data.token || ""
    };
}

export async function uploadFileToGofile(file, { onProgress } = {}) {
    const formData = new FormData();
    formData.append("file", file, file.name);

    const uploadUrl = resolveGofileUploadUrl();
    const apiToken = resolveGofileApiToken();

    return await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", uploadUrl);

        if (apiToken) {
            xhr.setRequestHeader("Authorization", `Bearer ${apiToken}`);
        }

        if (typeof onProgress === "function") {
            xhr.upload.onprogress = onProgress;
        }

        xhr.onload = () => {
            let payload = null;
            try {
                payload = JSON.parse(xhr.responseText || "{}");
            } catch (error) {
                payload = null;
            }

            if (xhr.status < 200 || xhr.status >= 300) {
                const error = new Error(payload?.statusText || payload?.error || `Gofile upload failed (${xhr.status}).`);
                error.status = xhr.status;
                error.payload = payload;
                reject(error);
                return;
            }

            const normalized = normalizePayloadResponse(payload);
            if (!normalized.ok) {
                reject(new Error("Gofile upload succeeded, but no usable file link was returned."));
                return;
            }

            resolve(normalized);
        };

        xhr.onerror = () => reject(new Error("Could not reach Gofile."));
        xhr.send(formData);
    });
}
