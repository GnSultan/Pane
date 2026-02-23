export function getFileName(filePath: string): string {
  return filePath.split("/").pop() ?? filePath;
}

export function getParentDir(filePath: string): string {
  const parts = filePath.split("/");
  parts.pop();
  return parts.join("/") || "/";
}
