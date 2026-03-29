/**
 * Pane Tool Executor
 *
 * Executes tools locally for HTTP backends (DeepSeek, Kimi, Anthropic, etc.)
 * Handles Bash commands, file operations, and other tools that CLI backends
 * would execute themselves.
 *
 * Architecture:
 * 1. Receives tool calls from HTTP backend
 * 2. Executes them locally with proper sandboxing
 * 3. Returns results formatted for the LLM
 * 4. Maintains execution context per project
 */

import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { spawn, exec } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import crypto from "node:crypto";

const execAsync = promisify(exec);

// ============================================================================
// Semantic Search Helpers (Lazy-loaded)
// ============================================================================

let globalEmbedder = null;
let globalEmbedderLoading = false;

async function getEmbedder(paneDir) {
  if (globalEmbedder) return globalEmbedder;
  if (globalEmbedderLoading) return null;
  globalEmbedderLoading = true;
  try {
    const { pipeline, env } = await import("@huggingface/transformers");
    env.cacheDir = path.join(paneDir, "brain", "models");
    env.backends.onnx.wasm.numThreads = 1;
    globalEmbedder = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
      quantized: true,
    });
    return globalEmbedder;
  } catch (err) {
    console.error("[tool-executor] Failed to load embedder:", err.message);
    globalEmbedderLoading = false;
    return null;
  }
}

async function embedText(text, paneDir) {
  const embedder = await getEmbedder(paneDir);
  if (!embedder) return null;
  try {
    const result = await embedder(text, { pooling: "mean", normalize: true });
    return Array.from(result.data);
  } catch {
    return null;
  }
}

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

function fuzzyScore(query, text) {
  const queryWords = query.split(/\s+/).filter((w) => w.length > 2);
  if (queryWords.length === 0) return 0;
  const lower = text.toLowerCase();
  const matches = queryWords.filter((w) => lower.includes(w)).length;
  return matches / queryWords.length;
}

// ============================================================================
// Constants & Configuration
// ============================================================================

const MAX_OUTPUT_SIZE = 100 * 1024; // 100KB max output
const COMMAND_TIMEOUT_MS = 30000; // 30 seconds for commands
const DEFAULT_ENCODING = "utf-8";

// Dangerous command patterns (blacklist)
const DANGEROUS_COMMAND_PATTERNS = [
  /rm\s+.*-rf?\s+\//, // Root deletion
  /rm\s+.*-rf?\s+\*/, // Catch-all deletion
  /rm\s+.*\.\.\//,    // Relative deletion
  /mkfs/,             // Disk formatting
  /dd\s+if=.*(of=\/dev\/(sd|xvd|vd|nvme|loop|nbd))/, // Raw disk writing to block devices
  /passwd/,           // Password changing
  /shutdown|reboot/,  // System control
  /chmod\s+.*777/,    // Dangerous permissions
  // Block writes to system devices EXCEPT harmless ones
  // Allowed: /dev/null, /dev/zero, /dev/random, /dev/urandom, /dev/stdin, /dev/stdout, /dev/stderr, /dev/fd/
  />\s*\/dev\/(?!null|zero|random|urandom|stdin|stdout|stderr|fd\/)/,
];

/**
 * Validates a shell command for safety.
 *
 * Switch to Blacklist approach: Allow everything EXCEPT explicitly dangerous
 * patterns and attempts to escape the project directory.
 */
function validateCommand(command, projectRoot) {
  const trimmed = command.trim();
  if (!trimmed) return { valid: false, error: "Empty command" };

  // 1. Check against blacklist
  for (const pattern of DANGEROUS_COMMAND_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        valid: false,
        error: `Command contains dangerous pattern: ${pattern}`,
      };
    }
  }

  // 2. Check for attempts to escape directory
  // Allow 'node_modules/..' as it's common in npm operations.
  if (trimmed.includes("..") && !trimmed.includes("node_modules/..")) {
    if (trimmed.includes("../../")) {
      return {
        valid: false,
        error: "Path traversal detected (attempt to escape project)",
      };
    }
  }

  // 3. Block absolute paths to system directories
  const systemPaths = ["/etc/", "/var/", "/bin/", "/sbin/", "/usr/", "/root/"];
  for (const sysPath of systemPaths) {
    if (trimmed.includes(sysPath) && !trimmed.includes(projectRoot)) {
      return {
        valid: false,
        error: `Attempt to access system directory: ${sysPath}`,
      };
    }
  }

  return { valid: true };
}

// ============================================================================
// Change history write queue — shared across all ToolExecutor instances.
// Serializes writes per project so concurrent tool calls never race on the file.
// ============================================================================

const changeHistoryQueues = new Map(); // projectId -> Promise tail

function enqueueChangeWrite(projectId, fn) {
  const prev = changeHistoryQueues.get(projectId) ?? Promise.resolve();
  const next = prev.then(fn).catch(err =>
    console.error("[tool-executor] change-history write failed:", err.message)
  );
  changeHistoryQueues.set(projectId, next.then(() => {
    if (changeHistoryQueues.get(projectId) === next) changeHistoryQueues.delete(projectId);
  }));
  return next;
}

// ============================================================================
// Tool Executor Class
// ============================================================================

export class ToolExecutor {
  /**
   * @param {string} projectId - The project ID for context
   * @param {string} projectRoot - Root directory of the project
   * @param {Function} onEvent - Callback for emitting events
   */
  constructor(projectId, projectRoot, onEvent) {
    this.projectId = projectId;
    this.projectRoot = projectRoot;
    this.onEvent = onEvent;
    this.activeProcesses = new Map(); // toolId -> child process
    this.executionContext = {
      cwd: projectRoot,
      env: this.getSafeEnvironment(),
      shell: true,
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_SIZE,
      killSignal: "SIGTERM",
    };
  }

  /**
   * Record a change in the change history.
   * Writes are serialized per project via a queue and use atomic temp→rename.
   */
  async recordChange(change) {
    const paneDir = path.join(os.homedir(), ".pane");
    const histDir = path.join(paneDir, "change-history", this.projectId);
    const histFile = path.join(histDir, "changes.json");

    const newChange = {
      id: `ch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: change.timestamp || Date.now(),
      file: change.filePath,
      oldString: change.oldString,
      newString: change.newString,
      description: change.description || "",
    };

    await enqueueChangeWrite(this.projectId, async () => {
      let changes = [];
      try {
        changes = JSON.parse(await fsPromises.readFile(histFile, "utf-8"));
      } catch {
        // Missing or corrupt — start fresh
      }
      changes.unshift(newChange);
      await fsPromises.mkdir(histDir, { recursive: true });
      // Atomic: write to .tmp then rename — no partial-write corruption
      const tmp = histFile + ".tmp";
      await fsPromises.writeFile(tmp, JSON.stringify(changes.slice(0, 500), null, 2), "utf-8");
      await fsPromises.rename(tmp, histFile);
    });

    return { id: newChange.id, success: true };
  }

  /**
   * Get safe environment variables for command execution
   */
  getSafeEnvironment() {
    const env = { ...process.env };

    // Safe PATH - only include common binary directories
    const safePaths = [
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      "/opt/homebrew/bin", // Homebrew on Apple Silicon
      "/opt/local/bin", // MacPorts
      `${os.homedir()}/.local/bin`,
      `${os.homedir()}/.cargo/bin`,
      `${os.homedir()}/.npm-global/bin`,
    ].filter((p) => fs.existsSync(p));

    env.PATH = safePaths.join(":");

    // Remove dangerous environment variables
    delete env.SSH_AUTH_SOCK;
    delete env.GPG_AGENT_INFO;
    delete env.DBUS_SESSION_BUS_ADDRESS;

    // Set safe defaults
    env.HOME = os.homedir();
    env.USER = os.userInfo().username;
    env.SHELL = "/bin/bash";
    env.TERM = "xterm-256color";

    return env;
  }

  /**
   * Validate a shell command for safety
   */
  validateCommand(command) {
    return validateCommand(command, this.projectRoot);
  }

  /**
   * Execute a Bash command
   */
  async executeBash(toolId, command, background = false, cwd = null) {
    try {
      // Validate command
      const validation = this.validateCommand(command);
      if (!validation.valid) {
        return {
          success: false,
          error: `Command validation failed: ${validation.error}`,
          toolId,
        };
      }

      const execOptions = { ...this.executionContext };
      if (cwd) {
        const resolvedCwd = this.resolveProjectPath(cwd);
        if (resolvedCwd) execOptions.cwd = resolvedCwd;
      }

      if (background) {
        // Run in background
        const child = spawn(command, {
          ...execOptions,
          detached: true,
          stdio: "ignore",
        });

        child.unref();
        this.activeProcesses.set(toolId, child);

        return {
          success: true,
          output: `Command running in background (PID: ${child.pid})`,
          toolId,
          pid: child.pid,
        };
      } else {
        // Run and capture output
        const startTime = Date.now();

        const { stdout, stderr } = await execAsync(command, {
          ...execOptions,
          encoding: DEFAULT_ENCODING,
        });

        const duration = Date.now() - startTime;

        // Combine stdout and stderr
        let output = "";
        if (stdout) output += stdout;
        if (stderr) {
          if (output) output += "\n";
          output += `STDERR: ${stderr}`;
        }

        // Truncate if too large
        if (output.length > MAX_OUTPUT_SIZE) {
          output =
            output.substring(0, MAX_OUTPUT_SIZE) + "\n...[output truncated]";
        }

        return {
          success: true,
          output: output || "(no output)",
          toolId,
          duration,
          exitCode: 0,
        };
      }
    } catch (error) {
      // execAsync throws on non-zero exit code
      if (error.code && error.signal === null) {
        // Command failed with exit code
        return {
          success: false,
          error: `Command failed with exit code ${error.code}`,
          output: error.stderr || error.stdout || error.message,
          toolId,
          exitCode: error.code,
        };
      } else if (error.signal) {
        // Command killed by signal
        return {
          success: false,
          error: `Command killed by signal: ${error.signal}`,
          output: error.stderr || error.stdout || error.message,
          toolId,
          signal: error.signal,
        };
      } else {
        // Other error
        return {
          success: false,
          error: error.message,
          toolId,
        };
      }
    }
  }

  /**
   * Read file contents
   */
  async executeReadFile(toolId, filePath, startLine = null, endLine = null) {
    try {
      // Resolve and validate path
      const resolvedPath = this.resolveProjectPath(filePath);
      if (!resolvedPath) {
        return {
          success: false,
          error: `Invalid file path: ${filePath}`,
          toolId,
        };
      }

      // Check if file exists
      try {
        await fsPromises.access(resolvedPath, fs.constants.R_OK);
      } catch {
        return {
          success: false,
          error: `File does not exist or is not readable: ${filePath}`,
          toolId,
        };
      }

      // Get file stats
      const stats = await fsPromises.stat(resolvedPath);

      // Check if it's a directory
      if (stats.isDirectory()) {
        return {
          success: false,
          error: `${filePath} is a directory. Use list_directory to see its contents.`,
          toolId,
        };
      }

      // Read file
      const content = await fsPromises.readFile(resolvedPath, DEFAULT_ENCODING);
      let output = content;

      // Apply line limits if provided
      if (startLine !== null || endLine !== null) {
        const lines = content.split("\n");
        const start = startLine !== null ? Math.max(0, startLine - 1) : 0;
        const end = endLine !== null ? Math.min(lines.length, endLine) : lines.length;
        output = lines.slice(start, end).join("\n");
      }

      // Check output size
      if (output.length > 10 * 1024 * 1024) {
        // 10MB limit
        return {
          success: false,
          error: `Content too large (${Math.round(output.length / 1024 / 1024)}MB). Max size is 10MB.`,
          toolId,
        };
      }

      return {
        success: true,
        output,
        toolId,
        metadata: {
          path: filePath,
          size: stats.size,
          mtime: stats.mtime,
          startLine,
          endLine,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        toolId,
      };
    }
  }

  /**
   * List directory contents
   */
  async executeListDirectory(toolId, dirPath) {
    try {
      const resolvedPath = this.resolveProjectPath(dirPath);
      if (!resolvedPath) {
        return { success: false, error: `Invalid path: ${dirPath}`, toolId };
      }

      const stats = await fsPromises.stat(resolvedPath);
      if (!stats.isDirectory()) {
        return { success: false, error: `${dirPath} is not a directory.`, toolId };
      }

      const files = await fsPromises.readdir(resolvedPath);
      const fileList = files.map((f) => {
        try {
          const fullPath = path.join(resolvedPath, f);
          const fileStat = fs.statSync(fullPath);
          return {
            name: f,
            type: fileStat.isDirectory() ? "directory" : "file",
            size: fileStat.size,
            modified: fileStat.mtime,
          };
        } catch {
          return { name: f, type: "unknown" };
        }
      });

      return {
        success: true,
        output: JSON.stringify({
          path: dirPath,
          contents: fileList,
          fileCount: files.length,
        }, null, 2),
        toolId,
      };
    } catch (error) {
      return { success: false, error: error.message, toolId };
    }
  }

  /**
   * Write file contents
   */
  async executeWriteFile(toolId, filePath, content) {
    try { await fsPromises.appendFile(path.join(os.homedir(), ".pane", "record-change-debug.log"), `[${new Date().toISOString()}] executeWriteFile called: file=${filePath}\n`); } catch {}
    try {
      // Resolve and validate path
      const resolvedPath = this.resolveProjectPath(filePath);
      if (!resolvedPath) {
        return {
          success: false,
          error: `Invalid file path: ${filePath}`,
          toolId,
        };
      }

      // Read previous content before overwriting (for change history)
      let previousContent = "";
      try {
        previousContent = await fsPromises.readFile(resolvedPath, DEFAULT_ENCODING);
      } catch {
        // File doesn't exist yet — new file creation, oldString stays ""
      }

      // Ensure directory exists
      await fsPromises.mkdir(path.dirname(resolvedPath), { recursive: true });

      // Write file
      await fsPromises.writeFile(resolvedPath, content, DEFAULT_ENCODING);

      // Record the change in change history
      try {
        const relativePath = path.relative(this.projectRoot, resolvedPath);
        await this.recordChange({
          filePath: relativePath,
          oldString: previousContent,
          newString: content,
          timestamp: Date.now(),
        });
      } catch (recorderError) {
        console.error("Failed to record change:", recorderError);
      }

      // Get file stats
      const stats = await fsPromises.stat(resolvedPath);

      return {
        success: true,
        output: `File written successfully: ${filePath} (${stats.size} bytes)`,
        toolId,
        metadata: {
          path: filePath,
          size: stats.size,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        toolId,
      };
    }
  }

  /**
   * Surgical edit: replace old_string with new_string
   */
  async executeReplace(toolId, filePath, oldString, newString) {
    try { await fsPromises.appendFile(path.join(os.homedir(), ".pane", "record-change-debug.log"), `[${new Date().toISOString()}] executeReplace called: file=${filePath}\n`); } catch {}
    try {
      // Resolve and validate path
      const resolvedPath = this.resolveProjectPath(filePath);
      if (!resolvedPath) {
        return {
          success: false,
          error: `Invalid file path: ${filePath}`,
          toolId,
        };
      }

      // Check if file exists and is readable
      try {
        await fsPromises.access(
          resolvedPath,
          fs.constants.R_OK | fs.constants.W_OK,
        );
      } catch {
        return {
          success: false,
          error: `File does not exist or is not writable: ${filePath}`,
          toolId,
        };
      }

      // Read current content
      const currentContent = await fsPromises.readFile(
        resolvedPath,
        DEFAULT_ENCODING,
      );

      // Check for exact match
      if (!currentContent.includes(oldString)) {
        return {
          success: false,
          error: "Could not find the specified string to replace",
          toolId,
          hint: "Make sure old_string exactly matches the content in the file, including indentation and whitespace.",
        };
      }

      // Check for multiple occurrences
      const occurrences = currentContent.split(oldString).length - 1;
      if (occurrences > 1) {
        return {
          success: false,
          error: `Found ${occurrences} occurrences of old_string. Please provide more context to make it unique.`,
          toolId,
        };
      }

      // Replace
      const newContent = currentContent.replace(oldString, newString);
      await fsPromises.writeFile(resolvedPath, newContent, DEFAULT_ENCODING);

      // Record the change in change history
      try {
        const relativePath = path.relative(this.projectRoot, resolvedPath);
        await this.recordChange({
          filePath: relativePath,
          oldString,
          newString,
          timestamp: Date.now(),
        });
      } catch (recorderError) {
        console.error("Failed to record change:", recorderError);
        // Don't fail the operation if recording fails
      }

      const stats = await fsPromises.stat(resolvedPath);

      return {
        success: true,
        output: `File edited: ${filePath}\nNew size: ${stats.size} bytes`,
        toolId,
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        toolId,
      };
    }
  }

  /**
   * Search for patterns in files (grep)
   */
  async executeGrepSearch(toolId, query, searchPath = ".", includePattern = null) {
    try {
      const resolvedSearchPath = this.resolveProjectPath(searchPath);
      if (!resolvedSearchPath) {
        return { success: false, error: `Invalid search path: ${searchPath}`, toolId };
      }

      const results = [];
      const commonExtensions = [
        ".js", ".ts", ".mjs", ".cjs", ".jsx", ".tsx", ".py", ".rb", ".java", ".cpp", ".c", ".h", ".hpp", ".go", ".rs", ".php", ".html", ".css", ".scss", ".less", ".json", ".yml", ".yaml", ".toml", ".md", ".txt", ".sh", ".bash",
      ];

      const includeRegex = includePattern 
        ? new RegExp(includePattern.replace(/\*/g, ".*").replace(/\?/g, "."))
        : null;

      const walk = async (dir) => {
        let files = [];
        try {
          const items = await fsPromises.readdir(dir, { withFileTypes: true });
          for (const item of items) {
            const fullPath = path.join(dir, item.name);
            if (item.isDirectory()) {
              if (![ "node_modules", ".git", ".next", ".nuxt", ".output", "dist", "build", "coverage", ".cache", ].includes(item.name)) {
                files = files.concat(await walk(fullPath));
              }
            } else {
              const ext = path.extname(item.name).toLowerCase();
              if (includeRegex) {
                if (includeRegex.test(item.name) || includeRegex.test(fullPath)) {
                  files.push(fullPath);
                }
              } else if (commonExtensions.includes(ext)) {
                files.push(fullPath);
              }
            }
          }
        } catch (error) {}
        return files;
      };

      const allFiles = await walk(resolvedSearchPath);
      const filesToSearch = allFiles.slice(0, 100);

      for (const file of filesToSearch) {
        try {
          const content = await fsPromises.readFile(file, DEFAULT_ENCODING);
          const lines = content.split("\n");
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes(query)) {
              results.push({
                file: path.relative(this.projectRoot, file),
                line: i + 1,
                content: lines[i].trim(),
              });
              if (results.length >= 50) break;
            }
          }
          if (results.length >= 50) break;
        } catch (error) { continue; }
      }

      if (results.length === 0) {
        return { success: true, output: `No matches found for "${query}"`, toolId };
      }

      const output = results.map((r) => `${r.file}:${r.line}: ${r.content}`).join("\n");
      return { success: true, output: `Found ${results.length} match(es) for "${query}":\n\n${output}`, toolId };
    } catch (error) {
      return { success: false, error: error.message, toolId };
    }
  }

  /**
   * Glob search for files
   */
  async executeGlob(toolId, pattern, dirPath = null) {
    try {
      let cwd = this.projectRoot;
      if (dirPath) {
        const resolved = this.resolveProjectPath(dirPath);
        if (resolved) cwd = resolved;
      }

      const { glob } = await import("glob");
      const matches = await glob(pattern, { cwd, absolute: false, ignore: ["node_modules/**", ".git/**", "dist/**", "build/**"] });
      
      if (matches.length === 0) {
        return { success: true, output: `No files matched pattern: ${pattern}`, toolId };
      }

      return {
        success: true,
        output: matches.join("\n"),
        toolId,
        metadata: { pattern, count: matches.length, cwd }
      };
    } catch (error) {
      return { success: false, error: error.message, toolId };
    }
  }

  /**
   * Fetch a URL and extract text content
   */
  async executeWebFetch(toolId, prompt) {
    const urlMatch = prompt.match(/https?:\/\/[^\s]+/);
    if (!urlMatch) {
      return { success: false, output: "No URL found in the prompt.", toolId };
    }
    const url = urlMatch[0];
    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        },
        signal: AbortSignal.timeout(15000)
      });
      if (!response.ok) {
        return { success: false, output: `Failed to fetch URL: ${response.status} ${response.statusText}`, toolId };
      }
      const text = await response.text();
      // Very basic HTML to text conversion
      const cleanText = text
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
        .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 15000); // Cap at 15k chars

      return { success: true, output: cleanText, toolId };
    } catch (err) {
      return { success: false, output: `Error fetching URL: ${err.message}`, toolId };
    }
  }

  /**
   * Search Google (placeholder implementation)
   */
  async executeGoogleWebSearch(toolId, query) {
    return {
      success: true,
      output: `Searching for: ${query}\n(Web search results are currently unavailable in this environment. Please provide the information manually if available.)`,
      toolId
    };
  }

  /**
   * Resolve a file path relative to project root, with safety checks
   */
  resolveProjectPath(filePath) {
    if (!filePath || typeof filePath !== "string") {
      return null;
    }

    // Normalize path
    const normalized = path.normalize(filePath);

    // Check for path traversal attempts
    if (normalized.includes("..") || path.isAbsolute(normalized)) {
      // Only allow relative paths within project
      if (
        path.isAbsolute(normalized) &&
        !normalized.startsWith(this.projectRoot)
      ) {
        return null;
      }
    }

    // Resolve relative to project root
    const resolved = path.resolve(this.projectRoot, normalized);

    // Ensure the resolved path is within project root
    if (!resolved.startsWith(this.projectRoot)) {
      return null;
    }

    return resolved;
  }

  /**
   * Execute any tool by name
   */
  async executeTool(toolId, toolName, input) {
    const paneDir = path.join(os.homedir(), ".pane");
    const stateDir = path.join(paneDir, "state", this.projectId);
    const memoryDir = path.join(paneDir, "memory", this.projectId);

    const readJson = async (p) => {
      try { return JSON.parse(await fsPromises.readFile(p, "utf-8")); }
      catch { return null; }
    };

    try {
      switch (toolName) {
        case "run_shell_command":
        case "bash":
          return await this.executeBash(toolId, input.command, input.is_background || input.background || false, input.dir_path || null);

        case "Read":
        case "read_file":
          return await this.executeReadFile(toolId, input.file_path || input.path, input.start_line || null, input.end_line || null);

        case "list_directory":
          return await this.executeListDirectory(toolId, input.dir_path || input.path);

        case "write_file":
          return await this.executeWriteFile(toolId, input.file_path || input.path, input.content);

        case "replace":
          return await this.executeReplace(toolId, input.file_path || input.path, input.old_string, input.new_string);

        case "Glob":
        case "glob":
          return await this.executeGlob(toolId, input.pattern, input.dir_path || null);

        case "Grep":
        case "grep_search":
          return await this.executeGrepSearch(toolId, input.pattern || input.query, input.dir_path || input.path || ".", input.include_pattern || null);

        case "google_web_search":
          return await this.executeGoogleWebSearch(toolId, input.query);

        case "web_fetch":
          return await this.executeWebFetch(toolId, input.prompt);

        case "pane_project_context": {
          const data = await readJson(path.join(stateDir, "project.json"));
          if (!data) {
            return {
              success: true,
              output: `Project: ${this.projectId}\nRoot: ${this.projectRoot}\nNo state file found yet — Pane hasn't synced state.`,
              toolId
            };
          }
          let out = `Project: ${data.name}\nRoot: ${data.root}`;
          if (data.gitBranch) out += `\nGit branch: ${data.gitBranch}`;
          if (data.topLevelFiles?.length) out += `\nTop-level files:\n${data.topLevelFiles.map(f => `  ${f}`).join("\n")}`;
          return { success: true, output: out, toolId };
        }

        case "pane_open_files": {
          const data = await readJson(path.join(stateDir, "editor.json"));
          if (!data || !data.activeFile) return { success: true, output: "No file currently open in editor.", toolId };
          let out = `Open file: ${data.activeFile}`;
          if (data.recentFiles?.length > 1) {
            out += `\nRecent files: ${data.recentFiles.slice(0, 10).join(", ")}`;
          }
          if (data.content) {
            const lines = data.content.split("\n");
            const preview = lines.length > 200
              ? lines.slice(0, 200).join("\n") + `\n... (${lines.length - 200} more lines)`
              : data.content;
            out += `\n\n--- Content ---\n${preview}`;
          }
          return { success: true, output: out, toolId };
        }

        case "pane_recent_terminal": {
          const data = await readJson(path.join(stateDir, "terminal.json"));
          if (!data?.commands?.length) return { success: true, output: "No terminal history.", toolId };
          const cmds = data.commands.slice(-50);

          // Show tab labels when more than one source is present
          const sources = new Set(cmds.map(c => c.tabId || c.source || "terminal"));
          const needsLabels = sources.size > 1;

          const out = cmds.map(c => {
            // Tail of output — most useful for servers where latest lines matter most
            const raw = c.output || "(no output)";
            const output = raw.length > 1000 ? "...\n" + raw.slice(-1000) : raw;
            const runningMark = c.partial ? " (running)" : "";

            let prefix = "";
            if (needsLabels) {
              if (c.source === "claude" || c.tabId === "claude") {
                prefix = "[claude] ";
              } else if (c.tabTitle) {
                prefix = `[${c.tabTitle}] `;
              } else if (c.tabId) {
                prefix = "[terminal] ";
              }
            }

            return `${prefix}$ ${c.cmd}${runningMark}\n${output}`;
          }).join("\n\n");

          return { success: true, output: out, toolId };
        }

        case "pane_run_in_terminal": {
          const command = (input?.command || "").trim();
          if (!command) return { success: false, error: "No command provided.", toolId };
          const result = await this.executeBash(toolId, command, false, null);
          // Append to terminal history so pane_recent_terminal and the UI reflect what Claude ran
          try {
            const termPath = path.join(stateDir, "terminal.json");
            let termData = null;
            try { termData = JSON.parse(await fsPromises.readFile(termPath, "utf-8")); } catch {}
            const commands = Array.isArray(termData?.commands) ? termData.commands : [];
            commands.push({
              cmd: command,
              output: result.output || result.error || "",
              timestamp: Date.now(),
              tabId: "claude",
              tabTitle: "claude",
              source: "claude",
            });
            await fsPromises.mkdir(stateDir, { recursive: true });
            await fsPromises.writeFile(termPath, JSON.stringify({ commands: commands.slice(-50) }));
          } catch {}
          return result;
        }

        case "pane_recall": {
          const query = (input?.query || "").trim();

          // Try brain semantic search first (if export exists)
          const brainExportPath = path.join(paneDir, "brain", "exports", `${this.projectId}.json`);
          if (query && fs.existsSync(brainExportPath)) {
            const exported = await readJson(brainExportPath);
            if (exported && exported.length > 0) {
              const queryEmbedding = await embedText(query, paneDir);
              const queryLower = query.toLowerCase();

              const scored = exported.map(node => {
                let score = 0;
                if (queryEmbedding && node.embedding) {
                  score = 0.6 * cosineSimilarity(queryEmbedding, node.embedding);
                }
                score += 0.4 * fuzzyScore(queryLower, (node.content || "").toLowerCase());
                return { ...node, score };
              }).filter(s => s.score > 0.15).sort((a, b) => b.score - a.score);

              if (scored.length > 0) {
                const matches = scored.slice(0, 30);
                const out = matches.map(r => {
                  return `[${r.type}] (match: ${(r.score * 100).toFixed(0)}%)\n${r.content}`;
                }).join("\n\n");
                return { success: true, output: out, toolId };
              }
            }
          }

          // Fallback: JSONL fuzzy search
          const eventsPath = path.join(memoryDir, "events.jsonl");
          let raw = "";
          try { raw = await fsPromises.readFile(eventsPath, "utf-8"); }
          catch { return { success: true, output: "No project memory yet — this is the first session.", toolId }; }

          const events = raw.trim().split("\n").map(line => {
            try { return JSON.parse(line); } catch { return null; }
          }).filter(Boolean);

          let matches;
          if (query) {
            const queryLower = query.toLowerCase();
            const scored = events.map(e => {
              const content = (e.content || "").toLowerCase();
              const type = (e.type || "").toLowerCase();
              const score = Math.max(fuzzyScore(queryLower, content), fuzzyScore(queryLower, type));
              return { event: e, score };
            }).filter(s => s.score > 0).sort((a, b) => b.score - a.score);
            matches = scored.map(s => s.event).slice(0, 30);
          } else {
            matches = events.slice(-30);
          }

          if (matches.length === 0) {
            return { success: true, output: query ? `No memories matching "${query}".` : "No memories recorded yet.", toolId };
          }

          const timeSince = (timestamp) => {
            const seconds = Math.floor((Date.now() - timestamp) / 1000);
            if (seconds < 60) return "just now";
            if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
            if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
            return `${Math.floor(seconds / 86400)}d ago`;
          };

          const out = matches.map(e => {
            const ago = e.timestamp ? timeSince(e.timestamp) : "";
            const meta = e.metadata ? Object.entries(e.metadata).map(([k, v]) => `${k}=${v}`).join(" ") : "";
            return `[${e.type}]${ago ? ` (${ago})` : ""}${meta ? ` {${meta}}` : ""}\n${e.content}`;
          }).join("\n\n");
          return { success: true, output: out, toolId };
        }

        case "pane_remember": {
          if (!input?.content) return { success: false, error: "Nothing to remember — content is required.", toolId };
          const event = {
            type: input.type || "decision",
            content: input.content,
            timestamp: Date.now(),
            source: "http-backend",
          };
          await fsPromises.mkdir(memoryDir, { recursive: true });
          await fsPromises.appendFile(
            path.join(memoryDir, "events.jsonl"),
            JSON.stringify(event) + "\n",
          );
          return { success: true, output: `Saved to project memory: [${event.type}] ${event.content}`, toolId };
        }

        case "pane_recall_all": {
          const query = (input?.query || "").trim();
          if (!query) return { success: false, error: "Query is required for cross-project search.", toolId };

          const memoryRoot = path.join(paneDir, "memory");
          let projectDirs;
          try { projectDirs = await fsPromises.readdir(memoryRoot); }
          catch { return { success: true, output: "No project memory found.", toolId }; }

          const queryLower = query.toLowerCase();
          const allResults = [];
          for (const projectDir of projectDirs) {
            const eventsPath = path.join(memoryRoot, projectDir, "events.jsonl");
            let raw = "";
            try { raw = await fsPromises.readFile(eventsPath, "utf-8"); } catch { continue; }

            const events = raw.trim().split("\n").map(line => {
              try { return JSON.parse(line); } catch { return null; }
            }).filter(Boolean);

            for (const e of events) {
              const content = (e.content || "").toLowerCase();
              const score = fuzzyScore(queryLower, content);
              if (score > 0) {
                allResults.push({ event: e, project: projectDir, score });
              }
            }
          }

          allResults.sort((a, b) => b.score - a.score);
          const top = allResults.slice(0, 20);

          if (top.length === 0) {
            return { success: true, output: `No memories matching "${query}" across any project.`, toolId };
          }

          const out = top.map(r => {
            const e = r.event;
            return `[${r.project}] [${e.type}]\n${e.content}`;
          }).join("\n\n");
          return { success: true, output: out, toolId };
        }

        case "pane_brief": {
          const briefPath = path.join(memoryDir, "brief.md");
          let brief = "";
          try { brief = await fsPromises.readFile(briefPath, "utf-8"); }
          catch { return { success: true, output: "No project brief yet — memory will accumulate as you work.", toolId }; }
          return { success: true, output: brief, toolId };
        }

        case "pane_checkpoints": {
          const cpDir = path.join(paneDir, "checkpoints", this.projectId);
          let manifest = null;
          try { manifest = JSON.parse(await fsPromises.readFile(path.join(cpDir, "manifest.json"), "utf-8")); }
          catch { return { success: true, output: "No checkpoints available.", toolId }; }

          if (!manifest?.checkpoints?.length) return { success: true, output: "No checkpoints available.", toolId };

          const out = manifest.checkpoints.map(cp => {
            return `${cp.id} — ${cp.fileCount} files`;
          }).join("\n");
          return { success: true, output: `${manifest.checkpoints.length} checkpoints:\n${out}`, toolId };
        }

        case "pane_change_history": {
          const changeHistoryDir = path.join(paneDir, "change-history", this.projectId);
          const changeHistoryFile = path.join(changeHistoryDir, "changes.json");
          let changes = [];
          try { changes = JSON.parse(await fsPromises.readFile(changeHistoryFile, "utf-8")); }
          catch { return { success: true, output: "No change history yet. Changes will be recorded as you edit files.", toolId }; }

          if (!changes || changes.length === 0) return { success: true, output: "No change history yet. Changes will be recorded as you edit files.", toolId };

          const out = changes.map(c => {
            const date = new Date(c.timestamp).toLocaleString();
            const shortOld = c.oldString.length > 50 ? c.oldString.slice(0, 50) + "..." : c.oldString;
            const shortNew = c.newString.length > 50 ? c.newString.slice(0, 50) + "..." : c.newString;
            return `${c.id} — ${c.file}\n  ${date}\n  "${shortOld}" → "${shortNew}"`;
          }).join("\n\n");
          return { success: true, output: `${changes.length} changes:\n\n${out}`, toolId };
        }

        case "pane_search_changes": {
          const { query, file_path: filePath } = input;
          const changeHistoryDir = path.join(paneDir, "change-history", this.projectId);
          const changeHistoryFile = path.join(changeHistoryDir, "changes.json");
          let changes = [];
          try { changes = JSON.parse(await fsPromises.readFile(changeHistoryFile, "utf-8")); }
          catch { return { success: true, output: "No change history to search.", toolId }; }

          let filtered = changes;
          if (filePath) {
            filtered = filtered.filter(c => c.file === filePath);
          }
          if (query) {
            const lowerQuery = query.toLowerCase();
            filtered = filtered.filter(c => 
              c.description?.toLowerCase().includes(lowerQuery) ||
              c.oldString?.toLowerCase().includes(lowerQuery) ||
              c.newString?.toLowerCase().includes(lowerQuery) ||
              c.file.toLowerCase().includes(lowerQuery)
            );
          }

          if (filtered.length === 0) return { success: true, output: "No matching changes found.", toolId };

          const out = filtered.map(c => {
            const date = new Date(c.timestamp).toLocaleString();
            return `${c.id} — ${c.file}\n  ${date}\n  "${c.oldString}" → "${c.newString}"`;
          }).join("\n\n");
          return { success: true, output: `${filtered.length} matching changes:\n\n${out}`, toolId };
        }

        case "pane_revert_change": {
          const { change_id: changeId } = input;
          const changeHistoryDir = path.join(paneDir, "change-history", this.projectId);
          const changeHistoryFile = path.join(changeHistoryDir, "changes.json");
          let changes = [];
          try { changes = JSON.parse(await fsPromises.readFile(changeHistoryFile, "utf-8")); }
          catch { return { success: false, error: "No change history found.", toolId }; }

          const changeIndex = changes.findIndex(c => c.id === changeId);
          if (changeIndex === -1) return { success: false, error: `Change ${changeId} not found.`, toolId };

          const change = changes[changeIndex];
          const resolvedPath = path.isAbsolute(change.file) ? change.file : path.join(this.projectRoot, change.file);

          try {
            const currentContent = await fsPromises.readFile(resolvedPath, "utf-8");
            if (!currentContent.includes(change.newString)) {
              return { success: false, error: "File content doesn't match expected change. The file may have been modified since this change was made.", toolId };
            }

            const revertedContent = currentContent.replace(change.newString, change.oldString);
            await fsPromises.writeFile(resolvedPath, revertedContent, "utf-8");

            changes.splice(changeIndex, 1);
            await fsPromises.writeFile(changeHistoryFile, JSON.stringify(changes, null, 2), "utf-8");

            return { success: true, output: `Reverted change in ${change.file}`, toolId };
          } catch (error) {
            return { success: false, error: error.message, toolId };
          }
        }

        case "pane_knowledge_graph": {
          const exportsDir = path.join(paneDir, "brain", "exports");
          let exported = null;
          try { exported = JSON.parse(await fsPromises.readFile(path.join(exportsDir, `${this.projectId}.json`), "utf-8")); }
          catch { return { success: true, output: "Knowledge graph is empty — it grows as you work.", toolId }; }

          if (!exported || exported.length === 0) return { success: true, output: "Knowledge graph is empty — it grows as you work.", toolId };

          const byType = {};
          for (const node of exported) {
            if (!byType[node.type]) byType[node.type] = [];
            byType[node.type].push(node);
          }

          const parts = [`Knowledge graph: ${exported.length} nodes\n`];
          for (const [type, nodes] of Object.entries(byType)) {
            parts.push(`### ${type} (${nodes.length})`);
            const sorted = nodes.slice(0, 5);
            for (const n of sorted) {
              parts.push(`  ${n.content.slice(0, 120)}`);
            }
          }
          return { success: true, output: parts.join("\n"), toolId };
        }

        case "pane_cross_project": {
          const query = (input?.query || "").trim();
          if (!query) return { success: false, error: "Query is required for cross-project search.", toolId };

          const exportsDir = path.join(paneDir, "brain", "exports");
          let files;
          try { files = await fsPromises.readdir(exportsDir); }
          catch { return { success: true, output: "No brain exports found.", toolId }; }

          const queryEmbedding = await embedText(query, paneDir);
          const queryLower = query.toLowerCase();

          const allResults = [];
          for (const file of files) {
            if (!file.endsWith(".json")) continue;
            const otherProjectId = file.replace(".json", "");
            if (otherProjectId === this.projectId) continue;

            let exported = null;
            try { exported = JSON.parse(await fsPromises.readFile(path.join(exportsDir, file), "utf-8")); } catch { continue; }
            if (!exported || exported.length === 0) continue;

            for (const node of exported) {
              if (!["decision", "lesson", "pattern", "error_fix"].includes(node.type)) continue;
              
              let score = 0;
              if (queryEmbedding && node.embedding) {
                score = 0.6 * cosineSimilarity(queryEmbedding, node.embedding);
              }
              score += 0.4 * fuzzyScore(queryLower, (node.content || "").toLowerCase());

              if (score > 0.3) {
                allResults.push({ ...node, project: otherProjectId, score });
              }
            }
          }

          allResults.sort((a, b) => b.score - a.score);
          const top = allResults.slice(0, 15);

          if (top.length === 0) return { success: true, output: `No cross-project insights found for "${query}".`, toolId };

          const out = top.map(r => `[${r.project}] [${r.type}] (match: ${(r.score * 100).toFixed(0)}%)\n${r.content}`).join("\n\n");
          return { success: true, output: out, toolId };
        }

        case "pane_profile": {
          const profileDir = path.join(paneDir, "profile");
          const parts = [];

          try {
            const exported = await fsPromises.readFile(path.join(profileDir, "profile-export.md"), "utf-8");
            if (exported.trim().length > 10) parts.push(exported.trim());
          } catch {}

          if (parts.length === 0) return { success: true, output: "Profile is empty — it will grow as Pane observes your work patterns.", toolId };
          return { success: true, output: parts.join("\n"), toolId };
        }

        case "pane_set_rule": {
          const rule = (input?.rule || "").trim();
          if (!rule) return { success: false, error: "Rule text is required.", toolId };

          const rulesPath = path.join(paneDir, "profile", "rules.md");
          let content = "";
          try { content = await fsPromises.readFile(rulesPath, "utf-8"); }
          catch { content = "# Explicit Rules\n"; }

          if (content.includes(rule)) return { success: true, output: `Rule already exists: "${rule}"`, toolId };

          content += `\n- ${rule}`;
          await fsPromises.mkdir(path.dirname(rulesPath), { recursive: true });
          await fsPromises.writeFile(rulesPath, content);
          return { success: true, output: `Rule added: "${rule}"`, toolId };
        }

        case "pane_set_philosophy": {
          const philosophy = (input?.philosophy || "").trim();
          if (!philosophy) return { success: false, error: "Philosophy text is required.", toolId };

          const philPath = path.join(paneDir, "profile", "philosophy.md");
          await fsPromises.mkdir(path.dirname(philPath), { recursive: true });
          await fsPromises.writeFile(philPath, philosophy);
          return { success: true, output: "Design philosophy updated.", toolId };
        }

        case "TodoWrite": {
          // Handled primarily by renderer side parsing, but acknowledge here
          const count = input.todos?.length || 0;
          return { success: true, output: `Updated TODO list with ${count} item(s).`, toolId };
        }

        case "Task": {
          const task = input.task || "unknown";
          return { success: true, output: `Active task set to: ${task}`, toolId };
        }

        case "activate_skill": {
          const name = input.name || "unknown";
          return { success: true, output: `Skill "${name}" activated. (Note: Skill instructions are normally injected into context; this is a mock confirmation.)`, toolId };
        }

        case "save_memory": {
          const fact = input.fact || "";
          if (!fact) return { success: false, error: "Fact is required.", toolId };
          
          const globalMemoryPath = path.join(os.homedir(), ".gemini", "memory.md");
          try {
            await fsPromises.mkdir(path.dirname(globalMemoryPath), { recursive: true });
            await fsPromises.appendFile(globalMemoryPath, `- ${fact}\n`);
            return { success: true, output: `Saved to global memory: ${fact}`, toolId };
          } catch (err) {
            return { success: false, error: `Failed to save memory: ${err.message}`, toolId };
          }
        }

        case "codebase_investigator": {
          const objective = input.objective || "none";
          return { success: true, output: `Delegating investigation to codebase_investigator: ${objective}\n(Note: Sub-agent execution is simulated in this environment. Please use available tools like grep_search and read_file directly.)`, toolId };
        }

        case "generalist": {
          const request = input.request || "none";
          return { success: true, output: `Delegating to generalist: ${request}\n(Note: Sub-agent execution is simulated.)`, toolId };
        }

        case "cli_help": {
          const question = input.question || "";
          return { success: true, output: `Gemini CLI Help for: ${question}\n(Note: Help system is simulated. Refer to project documentation.)`, toolId };
        }

        default:
          return { success: false, error: `Unknown tool: ${toolName}`, toolId };
      }
    } catch (error) {
      return { success: false, error: `Tool execution error: ${error.message}`, toolId };
    }
  }

  /**
   * Kill a running background process
   */
  killProcess(toolId) {
    const process = this.activeProcesses.get(toolId);
    if (process) {
      try {
        process.kill("SIGTERM");
        this.activeProcesses.delete(toolId);
        return { success: true, toolId };
      } catch (error) {
        return { success: false, error: error.message, toolId };
      }
    }
    return { success: false, error: "Process not found", toolId };
  }

  /**
   * Clean up all resources
   */
  cleanup() {
    for (const [toolId, process] of this.activeProcesses) {
      try { process.kill("SIGTERM"); } catch {}
    }
    this.activeProcesses.clear();
  }
}
