import { languages } from "@codemirror/language-data";
import { LanguageDescription, type LanguageSupport } from "@codemirror/language";

export async function loadLanguageForFile(
  filename: string,
): Promise<LanguageSupport | null> {
  const desc = LanguageDescription.matchFilename(languages, filename);
  if (!desc) return null;
  return desc.load();
}
