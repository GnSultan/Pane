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

// Safe command patterns (whitelist approach)
const SAFE_COMMAND_PATTERNS = [
  // Build tools
  /^(npm|yarn|pnpm|bun)\s+/,
  /^(make|cmake|meson|ninja)\s+/,
  /^(cargo|go|rustc|gcc|g\+\+|clang|clang\+\+)\s+/,

  // Package managers
  /^(pip|pip3|python3?\s+-m\s+pip)\s+/,
  /^(gem|bundle)\s+/,
  /^(apt-get|apt|yum|dnf|pacman|brew)\s+(install|update|upgrade|remove)/,

  // Version control
  /^(git|hg|svn)\s+/,

  // File operations (safe versions)
  /^(ls|find|grep|awk|sed|cat|head|tail|wc|du|df)\s+/,
  /^(mkdir|rmdir|cp|mv|rm\s+(-[^r]*|[^-].*))\s+/,
  /^(chmod|chown)\s+[0-7]{3,4}\s+/,

  // Process management
  /^(ps|top|htop|kill\s+-[^9]\S*)\s+/,

  // Network (safe)
  /^(curl|wget)\s+(-[^X]*|[^-].*)\s+/,
  /^(ping|traceroute|dig|nslookup)\s+/,

  // System info
  /^(uname|whoami|hostname|date|cal)\s*/,

  // Project-specific
  /^(node|python|python3|ruby|perl|php|java)\s+/,
];

// Dangerous command patterns (blacklist)
const DANGEROUS_COMMAND_PATTERNS = [
  /rm\s+.*-r/,
  /rm\s+.*-f/,
  /rm\s+.*-rf/,
  /rm\s+.*-rf/,
  /rm\s+.*\.\./,
  /rm\s+\/\s*$/,
  /rm\s+-\w*rf/,
  /dd\s+if=/,
  /mkfs/,
  /fdisk/,
  /format/,
  /shutdown/,
  /halt/,
  /reboot/,
  /init\s+[06]/,
  />\s*\/dev\/sd/,
  /cat\s+>\s*\/dev\/sd/,
  /chmod\s+[0-7]{3,4}\s+.*\/\.\./,
  /chown\s+.*\/\.\./,
  /curl\s+.*-X\s+(POST|PUT|DELETE).*\s+https?:\/\/localhost/,
  /wget\s+.*--post-.*\s+https?:\/\/localhost/,
  /nc\s+.*-e/,
  /bash\s+.*<\(/,
  /eval\s+/,
  /exec\s+/,
  /source\s+.*[;&|]/,
];

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
    if (!command || typeof command !== "string") {
      return { valid: false, error: "Empty or invalid command" };
    }

    const trimmed = command.trim();

    // Check against blacklist
    for (const pattern of DANGEROUS_COMMAND_PATTERNS) {
      if (pattern.test(trimmed)) {
        return {
          valid: false,
          error: `Command contains dangerous pattern: ${pattern}`,
        };
      }
    }

    // Check against whitelist (optional - can be more permissive if needed)
    let isSafe = false;
    for (const pattern of SAFE_COMMAND_PATTERNS) {
      if (pattern.test(trimmed)) {
        isSafe = true;
        break;
      }
    }

    if (!isSafe) {
      // Allow simple piping/redirecting if the base command is safe
      if (trimmed.includes("|") || trimmed.includes(">") || trimmed.includes("&")) {
        const baseCmd = trimmed.split(/[|>&]/)[0].trim();
        let baseSafe = false;
        for (const pattern of SAFE_COMMAND_PATTERNS) {
          if (pattern.test(baseCmd)) {
            baseSafe = true;
            break;
          }
        }
        if (!baseSafe) {
          return { valid: false, error: "Base command does not match safe patterns" };
        }
      } else {
        return { valid: false, error: "Command does not match safe patterns" };
      }
    }

    // Check for attempts to escape directory
    if (trimmed.includes("..") && !trimmed.includes("node_modules/..")) {
      // Allow 'node_modules/..' for npm operations
      if (!/node_modules\/\.\./.test(trimmed)) {
        return {
          valid: false,
          error: "Command contains parent directory reference (..)",
        };
      }
    }

    // Check for absolute path traversal
    if (trimmed.startsWith("/") && !trimmed.startsWith(this.projectRoot)) {
      return {
        valid: false,
        error: "Command attempts to access files outside project",
      };
    }

    return { valid: true };
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

      // Ensure directory exists
      await fsPromises.mkdir(path.dirname(resolvedPath), { recursive: true });

      // Write file
      await fsPromises.writeFile(resolvedPath, content, DEFAULT_ENCODING);

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

        case "read_file":
          return await this.executeReadFile(toolId, input.file_path || input.path, input.start_line || null, input.end_line || null);

        case "list_directory":
          return await this.executeListDirectory(toolId, input.dir_path || input.path);

        case "write_file":
          return await this.executeWriteFile(toolId, input.file_path || input.path, input.content);

        case "replace":
          return await this.executeReplace(toolId, input.file_path || input.path, input.old_string, input.new_string);

        case "glob":
          return await this.executeGlob(toolId, input.pattern, input.dir_path || null);

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
          const cmds = data.commands.slice(-20);
          const out = cmds.map(c => {
            const output = c.output?.length > 1000
              ? c.output.slice(0, 1000) + "\n... (truncated)"
              : c.output || "(no output)";
            return `$ ${c.cmd}\n${output}`;
          }).join("\n\n");
          return { success: true, output: out, toolId };
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
