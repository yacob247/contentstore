export const SCAN_BYTE_LIMIT = 2097152;

export const SAFE_URL_PROTOCOLS = ["http:", "https:"];

export const ZIP_LIKE_EXTENSIONS = ["zip", "jar", "apk", "docx", "xlsx", "pptx"];

export const ALLOW_EXTERNAL_URLS = false;

export const ALWAYS_REQUIRE_MANUAL_REVIEW = true;

export const BLOCKED_FILE_EXTENSIONS = [
  "exe",
  "dll",
  "msi",
  "scr",
  "com",
  "bat",
  "cmd",
  "ps1",
  "psm1",
  "vbs",
  "vbe",
  "wsf",
  "wsh",
  "hta",
  "jar",
  "apk",
  "js",
  "mjs",
  "cjs",
  "html",
  "htm",
  "svg",
  "reg"
];

export const FILE_HEADER_SIGNATURES = [
  {
    extensions: ["exe", "dll", "scr", "msi", "com"],
    signature: [0x4d, 0x5a],
    message: "it claims to be a Windows executable, but the binary header is not a valid MZ executable."
  },
  {
    extensions: ["zip", "jar", "apk", "docx", "xlsx", "pptx"],
    signature: [0x50, 0x4b, 0x03, 0x04],
    message: "it claims to be a ZIP-based package, but the binary header does not match that format."
  },
  {
    extensions: ["png"],
    signature: [0x89, 0x50, 0x4e, 0x47],
    message: "it claims to be a PNG image, but the file header does not match PNG."
  },
  {
    extensions: ["jpg", "jpeg"],
    signature: [0xff, 0xd8, 0xff],
    message: "it claims to be a JPEG image, but the file header does not match JPEG."
  },
  {
    extensions: ["gif"],
    signature: [0x47, 0x49, 0x46, 0x38],
    message: "it claims to be a GIF image, but the file header does not match GIF."
  },
  {
    extensions: ["pdf"],
    signature: [0x25, 0x50, 0x44, 0x46],
    message: "it claims to be a PDF document, but the file header does not match PDF."
  }
];

export const MALICIOUS_SIGNATURES = [
  {
    id: "powershell_payload",
    patterns: ["powershell -enc", "powershell.exe -enc", "frombase64string(", "invoke-webrequest", "downloadstring("],
    message: "it appears to contain PowerShell payload or download execution patterns."
  },
  {
    id: "command_shell",
    patterns: ["cmd.exe /c", "cmd /c", "%comspec%"],
    message: "it appears to launch system command shell instructions."
  },
  {
    id: "registry_changes",
    patterns: ["reg add", "reg delete", "hkey_local_machine", "hkey_current_user"],
    message: "it appears to modify the Windows Registry."
  },
  {
    id: "script_host",
    patterns: ["wscript.shell", "cscript.exe", "mshta ", "rundll32 ", "schtasks /create"],
    message: "it appears to invoke Windows script-host or scheduled-task execution tooling."
  },
  {
    id: "suspicious_transfer",
    patterns: ["certutil -urlcache", "bitsadmin /transfer"],
    message: "it appears to contain suspicious command-line download tooling."
  },
  {
    id: "active_script_execution",
    patterns: ["<script", "javascript:", "eval(", "new function(", "importscripts("],
    message: "it appears to contain active script execution code."
  },
  {
    id: "browser_data_access",
    patterns: ["document.cookie", "localstorage.", "sessionstorage.", "navigator.sendbeacon(", "indexeddb."],
    message: "it appears to access browser cookies, storage, or stealth data-transfer APIs."
  },
  {
    id: "frame_escape_access",
    patterns: ["window.parent", "window.top", "top.location", "parent.location", "postmessage("],
    message: "it appears to interact with parent frames or cross-context browser messaging."
  }
];

export const FIX_REQUIRED_SIGNATURES = [
  {
    id: "directx8_runtime",
    patterns: ["d3d8.dll"],
    allowedSources: ["file_content"],
    skipRawArchiveBytes: true,
    requiresContextAnyOf: [
      "missing",
      "not found",
      "requires",
      "required",
      "need ",
      "needs ",
      "dependency",
      "unable to",
      "could not",
      "cannot",
      "failed",
      "error"
    ],
    ignoreWhenMarkersPresent: ["dgvoodoo.conf", "dgvoodoocpl.exe", "readmedirectx.url"],
    message: "it references d3d8.dll. Bundle the required DirectX runtime or include setup instructions before resubmitting."
  },
  {
    id: "cd_media",
    patterns: ["mscdex", "requires cd", "insert cd", "cd-rom", "cdrom"],
    allowedSources: ["file_content"],
    message: "it appears to require CD media or virtual-drive setup. Explain that requirement clearly before resubmitting."
  },
  {
    id: "glide_runtime",
    patterns: ["glide2x.dll", "glide3x.dll"],
    allowedSources: ["file_content"],
    skipRawArchiveBytes: true,
    requiresContextAnyOf: [
      "missing",
      "not found",
      "requires",
      "required",
      "need ",
      "needs ",
      "dependency",
      "unable to",
      "could not",
      "cannot",
      "failed",
      "error"
    ],
    ignoreWhenMarkersPresent: ["dgvoodoo.conf", "dgvoodoocpl.exe", "readmeglide.url", "glide.dll"],
    message: "it references Glide runtime files. Include compatible wrappers or setup notes before resubmitting."
  }
];

export const FINDING_TEMPLATES = {
  invalid_local_file: "{{name}} was blocked because {{message}}",
  malicious_signature: "{{name}} was blocked because {{message}}",
  fix_required: "{{name}} needs changes before it can be posted because {{message}}",
  blocked_extension: "{{name}} was blocked because .{{extension}} files are disabled in strict security mode.",
  unsafe_url_protocol: "{{field}} must use one of these protocols: {{protocols}}.",
  external_urls_disabled: "{{field}} was blocked because external URLs are disabled in strict security mode.",
  review_only_external_url: "{{field}} uses an external URL that cannot be deeply scanned in the browser, so it will require admin review.",
  review_only_source_change: "{{field}} source changed, so it will require admin review."
};
