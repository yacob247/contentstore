import {
  FILE_HEADER_SIGNATURES,
  FINDING_TEMPLATES,
  FIX_REQUIRED_SIGNATURES,
  MALICIOUS_SIGNATURES,
  RESTRICTED_TERMS,
  SAFE_URL_PROTOCOLS,
  SCAN_BYTE_LIMIT
} from "./sandbox-rules.js";

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeSearchText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

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

function collectRestrictedTextFindings(text, field) {
  const normalizedText = normalizeSearchText(text);
  if (!normalizedText) return [];

  const findings = [];
  for (const term of RESTRICTED_TERMS) {
    const normalizedTerm = normalizeSearchText(term);
    if (!normalizedTerm) continue;

    const regex = new RegExp(`(?:^|\\s)${escapeRegExp(normalizedTerm)}(?=\\s|$)`, "i");
    if (regex.test(normalizedText)) {
      findings.push(
        makeFinding(
          "restricted_text",
          buildReason("restricted_text", { field, term }),
          { blocking: true, field, term }
        )
      );
    }
  }

  return dedupeFindings(findings);
}

function collectUrlValidationFindings(url, field) {
  if (!url) return [];

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

async function collectLocalFileFindings(file, displayName) {
  const name = file?.name || displayName || "Uploaded file";
  if (!file) return [];

  const findings = [];
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
  const extension = getFileExtension(name);
  const headerRule = FILE_HEADER_SIGNATURES.find((rule) => rule.extensions.includes(extension));

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
    const matchedPattern = rule.patterns.find((pattern) => lowerText.includes(pattern.toLowerCase()));
    if (!matchedPattern) continue;

    findings.push(
      makeFinding(
        "malicious_signature",
        buildReason("malicious_signature", {
          name,
          message: rule.message
        }),
        { blocking: true, fileName: name, ruleId: rule.id, matchedPattern }
      )
    );
  }

  if (findings.some((finding) => finding.type === "malicious_signature")) {
    return dedupeFindings(findings);
  }

  for (const rule of FIX_REQUIRED_SIGNATURES) {
    const matchedPattern = rule.patterns.find((pattern) => lowerText.includes(pattern.toLowerCase()));
    if (!matchedPattern) continue;

    findings.push(
      makeFinding(
        "fix_required",
        buildReason("fix_required", {
          name,
          message: rule.message
        }),
        { blocking: true, fileName: name, ruleId: rule.id, matchedPattern }
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
  title,
  description,
  draftImage,
  draftFiles,
  originalItem,
  isEditing
}) {
  const findings = [];
  const normalizedDraftFiles = Array.isArray(draftFiles) ? draftFiles : [];
  const originalFiles = Array.isArray(originalItem?.files) ? originalItem.files : [];

  findings.push(...collectRestrictedTextFindings(title, "Display Title"));
  findings.push(...collectRestrictedTextFindings(description, "Detailed Description"));

  normalizedDraftFiles.forEach((draft, index) => {
    findings.push(...collectRestrictedTextFindings(draft?.name, `File Label ${index + 1}`));
  });

  if (isEditing && normalizedDraftFiles.length !== originalFiles.length) {
    findings.push(collectReviewOnlyFinding("Attached files", "source_change"));
  }

  if (draftImage?.inputType === "url") {
    findings.push(...collectUrlValidationFindings(draftImage.url, "Cover Image URL"));

    const currentImageUrl = (draftImage.url || "").trim();
    const originalImageUrl = originalItem?.imageUrl || "";
    const hasNewExternalImage = currentImageUrl && (!isEditing || isChangedValue(currentImageUrl, originalImageUrl));
    const hasRemovedImage = isEditing && !currentImageUrl && originalImageUrl;

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
      findings.push(...collectUrlValidationFindings(draft.url, fieldLabel));
      const currentUrl = (draft.url || "").trim();
      const originalUrl = getOriginalFileUrl(originalItem, index);
      if (currentUrl && (!isEditing || isChangedValue(currentUrl, originalUrl))) {
        findings.push(collectReviewOnlyFinding(fieldLabel, "external_url"));
      }
    } else if (draft?.inputType === "upload" && draft.file) {
      findings.push(...await collectLocalFileFindings(draft.file, draft.file.name || draft.name || `Attached file ${index + 1}`));
      if (isEditing) findings.push(collectReviewOnlyFinding(`Attached file ${index + 1}`, "source_change"));
    }
  }

  const uniqueFindings = dedupeFindings(findings);
  const blockReasons = dedupeReasons(uniqueFindings.filter((finding) => finding.blocking).map((finding) => finding.reason));

  return {
    ok: blockReasons.length === 0,
    blockReasons,
    requiresReapproval: uniqueFindings.some((finding) => finding.type === "review_only"),
    findings: uniqueFindings
  };
}
