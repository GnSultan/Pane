// Shared noise filter for brain extraction and synthesis.
// Rejects shell commands, error-fix patterns, file paths, URLs, and
// content too terse to represent meaningful architectural knowledge.

export function isSignalNoise(text) {
  if (!text || text.length < 20) return true;
  // Shell commands and pipelines
  if (/^(cd |npm |git |node |ls |yarn |pnpm |npx |curl |wget |echo |export |source )/i.test(text)) return true;
  if (/&&|2>&1|\| tail|\| head|\| grep/.test(text)) return true;
  // Error-fix / tool error patterns
  if (/^Fixed:/i.test(text)) return true;
  if (/^Error:/i.test(text)) return true;
  if (/Unknown tool:/i.test(text)) return true;
  if (/<tool_use_error>/i.test(text)) return true;
  // Bare file paths or URLs
  if (/^\/[\w/.~-]+$/.test(text.trim())) return true;
  if (/^https?:\/\//i.test(text.trim())) return true;
  return false;
}
