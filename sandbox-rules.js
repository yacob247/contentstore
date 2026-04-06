export const SCAN_BYTE_LIMIT = 51200;

export const SAFE_URL_PROTOCOLS = ["http:", "https:"];

export const RESTRICTED_TERMS = [
  "porn",
  "nude",
  "nsfw",
  "escort",
  "camgirl",
  "onlyfans",
  "gambling",
  "casino",
  "betting",
  "xxx",
  "sex",
  "fuck",
  "shit",
  "bitch",
  "ass",
  "asshole",
  "dick",
  "cock",
  "pussy",
  "slut",
  "whore",
  "bastard",
  "cunt",
  "faggot",
  "nigger",
  "retard",
  "motherfucker",
  "twat",
  "cum",
  "anal",
  "penis",
  "vagina"
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
  }
];

export const FIX_REQUIRED_SIGNATURES = [
  {
    id: "directx8_runtime",
    patterns: ["d3d8.dll"],
    message: "it references d3d8.dll. Bundle the required DirectX runtime or include setup instructions before resubmitting."
  },
  {
    id: "cd_media",
    patterns: ["mscdex", "requires cd", "insert cd", "cd-rom", "cdrom"],
    message: "it appears to require CD media or virtual-drive setup. Explain that requirement clearly before resubmitting."
  },
  {
    id: "glide_runtime",
    patterns: ["glide2x.dll", "glide3x.dll"],
    message: "it references Glide runtime files. Include compatible wrappers or setup notes before resubmitting."
  }
];

export const FINDING_TEMPLATES = {
  restricted_text: 'The {{field}} contains a blocked term: "{{term}}".',
  invalid_local_file: "{{name}} was blocked because {{message}}",
  malicious_signature: "{{name}} was blocked because {{message}}",
  fix_required: "{{name}} needs changes before it can be posted because {{message}}",
  unsafe_url_protocol: "{{field}} must use one of these protocols: {{protocols}}.",
  review_only_external_url: "{{field}} uses an external URL that cannot be deeply scanned in the browser, so it will require admin review.",
  review_only_source_change: "{{field}} source changed, so it will require admin review."
};
