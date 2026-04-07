import {
  ALLOW_EXTERNAL_URLS,
  ALWAYS_REQUIRE_MANUAL_REVIEW,
  BLOCKED_FILE_EXTENSIONS,
  FILE_HEADER_SIGNATURES,
  FINDING_TEMPLATES,
  FIX_REQUIRED_SIGNATURES,
  MALICIOUS_SIGNATURES,
  SAFE_URL_PROTOCOLS,
  SCAN_BYTE_LIMIT,
  ZIP_LIKE_EXTENSIONS
} from "./sandbox-rules.js";
import { isTrustedExternalUrl } from "../content-link-utils.js";

function fillTemplate(template, values) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => String(values[key] ?? ""));
}

function buildReason(type, values) {
  return fillTemplate(FINDING_TEMPLATES[type], values);
}

function getFileExtension(name) {
  const match = /\.([^.]+)$/.exec(name || "");
  return match ? match[1].toLowerCase() : "";
}

function readUInt16LE(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readUInt32LE(bytes, offset) {
  return (
    bytes[offset] |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) |
    (bytes[offset + 3] << 24)
  ) >>> 0;
}

function hasSignature(bytes, signature) {
  if (!bytes || bytes.length < signature.length) return false;
  return signature.every((byte, index) => bytes[index] === byte);
}

function makeFinding(type, reason, { blocking = false, ...rest } = {}) {
  return { type, reason, blocking, ...rest };
}

function dedupeReasons(values) {
  return [...new Set(values.filter(Boolean))];
}

function dedupeFindings(findings) {
  const seen = new Set();
  return findings.filter((finding) => {
    const key = `${finding.type}:${finding.reason}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function getOriginalFileUrl(originalItem, index) {
  return originalItem?.files?.[index]?.url || "";
}

function isChangedValue(currentValue, originalValue) {
  return String(currentValue || "") !== String(originalValue || "");
}

function collectUrlValidationFindings(url, field) {
  if (!url) return [];

  if (!ALLOW_EXTERNAL_URLS && !isTrustedExternalUrl(url)) {
    return [
      makeFinding(
        "external_urls_disabled",
        buildReason("external_urls_disabled", { field }),
        { blocking: true, field }
      )
    ];
  }

  try {
    const parsed = new URL(url);
    if (SAFE_URL_PROTOCOLS.includes(parsed.protocol)) return [];
  } catch (error) {
    // Fall through to the same user-facing validation message.
  }

  return [
    makeFinding(
      "unsafe_url_protocol",
      buildReason("unsafe_url_protocol", {
        field,
        protocols: SAFE_URL_PROTOCOLS.join(", ")
      }),
      { blocking: true, field }
    )
  ];
}

async function readFileSample(file) {
  const buffer = await file.slice(0, SCAN_BYTE_LIMIT).arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const lowerText = new TextDecoder().decode(bytes).toLowerCase();
  return { bytes, lowerText };
}

function extractZipEntryNames(bytes, extension) {
  if (!["zip", "jar", "apk", "docx", "xlsx", "pptx"].includes(extension)) return [];

  const decoder = new TextDecoder();
  const names = [];

  for (let index = 0; index <= bytes.length - 30; ) {
    const isLocalFileHeader =
      bytes[index] === 0x50 &&
      bytes[index + 1] === 0x4b &&
      bytes[index + 2] === 0x03 &&
      bytes[index + 3] === 0x04;

    if (!isLocalFileHeader) {
      index += 1;
      continue;
    }

    const fileNameLength = readUInt16LE(bytes, index + 26);
    const extraFieldLength = readUInt16LE(bytes, index + 28);
    const compressedSize = readUInt32LE(bytes, index + 18);
    const nameStart = index + 30;
    const nameEnd = nameStart + fileNameLength;

    if (nameEnd > bytes.length) break;

    const entryName = decoder.decode(bytes.slice(nameStart, nameEnd)).replace(/\0/g, "").trim();
    if (entryName) names.push(entryName);

    const nextIndex = nameEnd + extraFieldLength + compressedSize;
    index = nextIndex > index ? nextIndex : index + 4;
  }

  return [...new Set(names)];
}

function findPatternMatch({ lowerText, archiveEntryNames }, patterns) {
  for (const pattern of patterns) {
    const lowerPattern = pattern.toLowerCase();

    const matchedEntryName = archiveEntryNames.find((entryName) => entryName.toLowerCase().includes(lowerPattern));
    if (matchedEntryName) {
      return { matchedPattern: pattern, source: "archive_entry_name", detail: matchedEntryName };
    }

    if (lowerText.includes(lowerPattern)) {
      return { matchedPattern: pattern, source: "file_content" };
    }
  }

  return null;
}

function buildSignatureReason(name, ruleMessage, match, mode) {
  const prefix = mode === "malicious" ? "was blocked" : "needs changes before it can be posted";

  if (match?.source === "archive_entry_name") {
    return `${name} ${prefix} because archive metadata contains the entry name "${match.detail}", which matched "${match.matchedPattern}" (${ruleMessage})`;
  }

  if (match?.matchedPattern) {
    return `${name} ${prefix} because its scanned bytes matched "${match.matchedPattern}" (${ruleMessage})`;
  }

  return buildReason(mode === "malicious" ? "malicious_signature" : "fix_required", {
    name,
    message: ruleMessage
  });
}

function hasRuleIgnoreMarker(rule, lowerText, archiveEntryNames) {
  const markers = Array.isArray(rule?.ignoreWhenMarkersPresent) ? rule.ignoreWhenMarkersPresent : [];
  if (!markers.length) return false;

  return markers.some((marker) => {
    const lowerMarker = String(marker).toLowerCase();
    return lowerText.includes(lowerMarker) || archiveEntryNames.some((entryName) => entryName.toLowerCase().includes(lowerMarker));
  });
}

function getRuleScanText(rule, lowerText, extension) {
  if (ZIP_LIKE_EXTENSIONS.includes(extension) && rule?.skipRawArchiveBytes) return "";
  return lowerText;
}

function matchesRequiredContext(rule, lowerText, matchIndex, patternLength) {
  const contextPatterns = Array.isArray(rule?.requiresContextAnyOf) ? rule.requiresContextAnyOf : [];
  if (!contextPatterns.length) return true;

  const radius = Number(rule?.contextWindowChars || 80);
  const snippet = lowerText.slice(Math.max(0, matchIndex - radius), Math.min(lowerText.length, matchIndex + patternLength + radius));
  return contextPatterns.some((pattern) => snippet.includes(String(pattern).toLowerCase()));
}

function findPatternMatchForRule({ lowerText, archiveEntryNames }, rule) {
  const patterns = Array.isArray(rule?.patterns) ? rule.patterns : [];
  const allowedSources = Array.isArray(rule?.allowedSources) && rule.allowedSources.length
    ? rule.allowedSources
    : ["archive_entry_name", "file_content"];

  for (const pattern of patterns) {
    const lowerPattern = pattern.toLowerCase();

    if (allowedSources.includes("archive_entry_name")) {
      const matchedEntryName = archiveEntryNames.find((entryName) => entryName.toLowerCase().includes(lowerPattern));
      if (matchedEntryName) {
        return { matchedPattern: pattern, source: "archive_entry_name", detail: matchedEntryName };
      }
    }

    if (allowedSources.includes("file_content") && lowerText) {
      let matchIndex = lowerText.indexOf(lowerPattern);
      while (matchIndex !== -1) {
        if (matchesRequiredContext(rule, lowerText, matchIndex, lowerPattern.length)) {
          return { matchedPattern: pattern, source: "file_content" };
        }
        matchIndex = lowerText.indexOf(lowerPattern, matchIndex + lowerPattern.length);
      }
    }
  }

  return null;
}

async function collectLocalFileFindings(file, displayName) {
  const name = file?.name || displayName || "Uploaded file";
  if (!file) return [];

  const findings = [];
  const extension = getFileExtension(name);

  if (BLOCKED_FILE_EXTENSIONS.includes(extension)) {
    findings.push(
      makeFinding(
        "blocked_extension",
        buildReason("blocked_extension", { name, extension }),
        { blocking: true, fileName: name, extension }
      )
    );
    return findings;
  }

  if (file.size === 0) {
    findings.push(
      makeFinding(
        "invalid_local_file",
        buildReason("invalid_local_file", {
          name,
          message: "the file is empty."
        }),
        { blocking: true, fileName: name }
      )
    );
    return findings;
  }

  const { bytes, lowerText } = await readFileSample(file);
  const headerRule = FILE_HEADER_SIGNATURES.find((rule) => rule.extensions.includes(extension));
  const archiveEntryNames = extractZipEntryNames(bytes, extension);

  if (headerRule && !hasSignature(bytes, headerRule.signature)) {
    findings.push(
      makeFinding(
        "invalid_local_file",
        buildReason("invalid_local_file", {
          name,
          message: headerRule.message
        }),
        { blocking: true, fileName: name }
      )
    );
  }

  for (const rule of MALICIOUS_SIGNATURES) {
    const match = findPatternMatchForRule(
      { lowerText: getRuleScanText(rule, lowerText, extension), archiveEntryNames },
      rule
    );
    if (!match) continue;

    findings.push(
      makeFinding(
        "malicious_signature",
        buildSignatureReason(name, rule.message, match, "malicious"),
        {
          blocking: true,
          fileName: name,
          ruleId: rule.id,
          matchedPattern: match.matchedPattern,
          matchSource: match.source,
          matchDetail: match.detail
        }
      )
    );
  }

  if (findings.some((finding) => finding.type === "malicious_signature")) {
    return dedupeFindings(findings);
  }

  for (const rule of FIX_REQUIRED_SIGNATURES) {
    if (hasRuleIgnoreMarker(rule, lowerText, archiveEntryNames)) continue;

    const match = findPatternMatchForRule(
      { lowerText: getRuleScanText(rule, lowerText, extension), archiveEntryNames },
      rule
    );
    if (!match) continue;

    findings.push(
      makeFinding(
        "fix_required",
        buildSignatureReason(name, rule.message, match, "fix_required"),
        {
          blocking: true,
          fileName: name,
          ruleId: rule.id,
          matchedPattern: match.matchedPattern,
          matchSource: match.source,
          matchDetail: match.detail
        }
      )
    );
  }

  return dedupeFindings(findings);
}

function collectReviewOnlyFinding(field, type) {
  const templateKey = type === "external_url" ? "review_only_external_url" : "review_only_source_change";
  return makeFinding(
    "review_only",
    buildReason(templateKey, { field }),
    { field }
  );
}

export async function auditSubmissionDraft({
  draftImage,
  draftFiles,
  originalItem,
  isEditing
}) {
  const findings = [];
  const normalizedDraftFiles = Array.isArray(draftFiles) ? draftFiles : [];
  const originalFiles = Array.isArray(originalItem?.files) ? originalItem.files : [];

  if (isEditing && normalizedDraftFiles.length !== originalFiles.length) {
    findings.push(collectReviewOnlyFinding("Attached files", "source_change"));
  }

  if (draftImage?.inputType === "url") {
    const currentImageUrl = (draftImage.url || "").trim();
    const originalImageUrl = originalItem?.imageUrl || "";
    const hasNewExternalImage = currentImageUrl && (!isEditing || isChangedValue(currentImageUrl, originalImageUrl));
    const hasRemovedImage = isEditing && !currentImageUrl && originalImageUrl;

    if (hasNewExternalImage) {
      findings.push(...collectUrlValidationFindings(currentImageUrl, "Cover Image URL"));
    }

    if (hasNewExternalImage) {
      findings.push(collectReviewOnlyFinding("Cover Image URL", "external_url"));
    } else if (hasRemovedImage) {
      findings.push(collectReviewOnlyFinding("Cover image", "source_change"));
    }
  } else if (draftImage?.inputType === "upload" && draftImage.file) {
    findings.push(...await collectLocalFileFindings(draftImage.file, draftImage.file.name || "Cover image"));
    if (isEditing) findings.push(collectReviewOnlyFinding("Cover image", "source_change"));
  }

  for (let index = 0; index < normalizedDraftFiles.length; index++) {
    const draft = normalizedDraftFiles[index];
    const fieldLabel = `File URL ${index + 1}`;

    if (draft?.inputType === "url") {
      const currentUrl = (draft.url || "").trim();
      const originalUrl = getOriginalFileUrl(originalItem, index);
      const hasNewExternalUrl = currentUrl && (!isEditing || isChangedValue(currentUrl, originalUrl));

      if (hasNewExternalUrl) {
        findings.push(...collectUrlValidationFindings(currentUrl, fieldLabel));
      }

      if (hasNewExternalUrl) {
        findings.push(collectReviewOnlyFinding(fieldLabel, "external_url"));
      }
    } else if (draft?.inputType === "upload" && draft.file) {
      findings.push(...await collectLocalFileFindings(draft.file, draft.file.name || draft.name || `Attached file ${index + 1}`));
      if (isEditing) findings.push(collectReviewOnlyFinding(`Attached file ${index + 1}`, "source_change"));
    }
  }

  const uniqueFindings = dedupeFindings(findings);
  const blockReasons = dedupeReasons(uniqueFindings.filter((finding) => finding.blocking).map((finding) => finding.reason));
  const reviewOnlyTriggered = uniqueFindings.some((finding) => finding.type === "review_only");
  const requiresManualReview = ALWAYS_REQUIRE_MANUAL_REVIEW && !isEditing;

  return {
    ok: blockReasons.length === 0,
    blockReasons,
    requiresReapproval: reviewOnlyTriggered || requiresManualReview,
    findings: uniqueFindings
  };
}
