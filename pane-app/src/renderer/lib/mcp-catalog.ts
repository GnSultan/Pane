/**
 * Curated catalog of popular MCP servers.
 *
 * Each entry encodes everything needed for one-click install:
 * - package name + args (so the user doesn't need to look them up)
 * - the env vars / inputs the server requires (so we only ask for secrets)
 * - a short description and category for browsing
 *
 * For servers that need no credentials (filesystem, sequential-thinking),
 * install is truly one-click — no form at all.
 */

/** A single required input for a catalog server (usually an API key or path). */
export interface CatalogInput {
  /** Env var name that the server reads (e.g. "GITHUB_PERSONAL_ACCESS_TOKEN"). */
  envKey: string;
  /** Human label for the form field (e.g. "GitHub Personal Access Token"). */
  label: string;
  /** Brief hint text shown as placeholder. */
  placeholder: string;
  /** Link to where the user can obtain this credential. */
  obtainUrl?: string;
  /** Obtain link label. */
  obtainLabel?: string;
  /** If true, the input is masked (password-type). Default true. */
  secret?: boolean;
}

export type ServerCategory =
  | "design"
  | "code"
  | "docs"
  | "data"
  | "search"
  | "productivity"
  | "reasoning";

/** A catalog entry describing a known MCP server. */
export interface CatalogServer {
  /** Unique id, also used as the default server name. */
  id: string;
  /** Display name. */
  name: string;
  /** Short description. */
  description: string;
  category: ServerCategory;
  /** Command to run (typically "npx"). */
  command: string;
  /** Arguments for the command. */
  args: string[];
  /** Required inputs — usually API keys. Empty = no config needed. */
  inputs: CatalogInput[];
  /** Optional extra env that's always set (not user-provided). */
  fixedEnv?: Record<string, string>;
  /** Whether this is an official Anthropic reference server. */
  official?: boolean;
}

export const MCP_CATALOG: CatalogServer[] = [
  // ── Official Anthropic reference servers ──────────────────────────────
  {
    id: "filesystem",
    name: "Filesystem",
    description:
      "Secure file read/write/search with configurable access boundaries.",
    category: "code",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem"],
    inputs: [
      {
        envKey: "_PATH_ARG",
        label: "Allowed directory",
        placeholder: "/Users/you/projects",
        secret: false,
        obtainUrl: undefined,
      },
    ],
    official: true,
  },
  {
    id: "sequential-thinking",
    name: "Sequential Thinking",
    description:
      "Dynamic, reflective problem-solving through structured thought sequences.",
    category: "reasoning",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
    inputs: [],
    official: true,
  },
  {
    id: "fetch",
    name: "Fetch",
    description:
      "Web content fetching and conversion for efficient LLM consumption.",
    category: "search",
    command: "uvx",
    args: ["--from", "mcp-server-fetch", "--with", "mcp<1.0", "mcp-server-fetch"],
    inputs: [],
    official: true,
  },
  {
    id: "git",
    name: "Git",
    description:
      "Read history, diff, stage, and commit inside local Git repositories.",
    category: "code",
    command: "uvx",
    args: ["mcp-server-git"],
    inputs: [
      {
        envKey: "_PATH_ARG",
        label: "Repository path",
        placeholder: "/Users/you/project",
        secret: false,
      },
    ],
    official: true,
  },

  // ── Third-party / vendor servers ──────────────────────────────────────
  {
    id: "github",
    name: "GitHub",
    description:
      "Repository management, issues, PRs, code search via the GitHub API.",
    category: "code",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    inputs: [
      {
        envKey: "GITHUB_PERSONAL_ACCESS_TOKEN",
        label: "GitHub Personal Access Token",
        placeholder: "ghp_xxxxxxxxxxxx",
        obtainUrl: "https://github.com/settings/tokens?type=beta",
        obtainLabel: "Create a token →",
        secret: true,
      },
    ],
  },
  {
    id: "figma",
    name: "Figma",
    description:
      "Access Figma files, components, comments, and design metadata.",
    category: "design",
    command: "npx",
    args: ["-y", "figma-developer-mcp", "--stdio"],
    inputs: [
      {
        envKey: "FIGMA_API_KEY",
        label: "Figma API Key",
        placeholder: "figd_xxxxxxxx",
        obtainUrl: "https://www.figma.com/developers/api#access-tokens",
        obtainLabel: "Get an API key →",
        secret: true,
      },
    ],
  },
  {
    id: "notion",
    name: "Notion",
    description: "Query and update Notion databases, pages, and blocks.",
    category: "productivity",
    command: "npx",
    args: ["-y", "@notionhq/notion-mcp-server"],
    inputs: [
      {
        envKey: "NOTION_TOKEN",
        label: "Notion Integration Token",
        placeholder: "ntn_xxxxxxxxxxxx",
        obtainUrl: "https://www.notion.so/profile/integrations",
        obtainLabel: "Create an integration →",
        secret: true,
      },
    ],
  },
  {
    id: "brave-search",
    name: "Brave Search",
    description: "Web and local search via the Brave Search API.",
    category: "search",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-brave-search"],
    inputs: [
      {
        envKey: "BRAVE_API_KEY",
        label: "Brave API Key",
        placeholder: "BSAxxxxxx",
        obtainUrl: "https://brave.com/search/api/",
        obtainLabel: "Get an API key →",
        secret: true,
      },
    ],
  },
  {
    id: "postgres",
    name: "PostgreSQL",
    description: "Query and inspect a PostgreSQL database (read-only schema).",
    category: "data",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-postgres"],
    inputs: [
      {
        envKey: "_PATH_ARG",
        label: "Connection string",
        placeholder: "postgresql://user:pass@localhost:5432/mydb",
        secret: false,
      },
    ],
  },
  {
    id: "gmail",
    name: "Gmail",
    description:
      "Read, search, send, and label email via the Google Workspace MCP (workspace-mcp).",
    category: "productivity",
    command: "uvx",
    args: ["workspace-mcp", "--tools", "gmail"],
    inputs: [
      {
        envKey: "GOOGLE_OAUTH_CLIENT_ID",
        label: "Google OAuth Client ID",
        placeholder: "1234567890-abc123.apps.googleusercontent.com",
        obtainUrl: "https://console.cloud.google.com/apis/credentials",
        obtainLabel: "Create OAuth credentials →",
        secret: false,
      },
      {
        envKey: "GOOGLE_OAUTH_CLIENT_SECRET",
        label: "Google OAuth Client Secret",
        placeholder: "GOCSPX-xxxxxxxxxxxxxxxx",
        obtainUrl: "https://console.cloud.google.com/apis/credentials",
        obtainLabel: "Create OAuth credentials →",
        secret: true,
      },
    ],
  },
  {
    id: "context7",
    name: "Context7",
    description:
      "Fetches live, version-specific docs for React, Next.js, Vue, and more — eliminates hallucinated APIs.",
    category: "docs",
    command: "npx",
    args: ["-y", "@upstash/context7-mcp"],
    inputs: [],
  },
  {
    id: "netlify",
    name: "Netlify",
    description: "Deploy, manage sites, and control DNS via the Netlify API.",
    category: "code",
    command: "npx",
    args: ["-y", "@netlify/mcp"],
    inputs: [
      {
        envKey: "NETLIFY_PERSONAL_ACCESS_TOKEN",
        label: "Netlify Personal Access Token",
        placeholder: "nfp_xxxxxxxx",
        obtainUrl: "https://app.netlify.com/user/applications",
        obtainLabel: "Create a token →",
        secret: true,
      },
    ],
  },
  {
    id: "vercel",
    name: "Vercel",
    description: "Manage Vercel projects, deployments, and environment variables.",
    category: "code",
    command: "npx",
    args: ["-y", "mcp-remote", "https://mcp.vercel.com"],
    inputs: [
      {
        envKey: "VERCEL_TOKEN",
        label: "Vercel Access Token",
        placeholder: "vrt_xxxxxxxx",
        obtainUrl: "https://vercel.com/account/tokens",
        obtainLabel: "Create a token →",
        secret: true,
      },
    ],
  },
];

/** Group catalog servers by category for display. */
export const CATEGORY_LABELS: Record<ServerCategory, string> = {
  design: "Design",
  code: "Code & Deploy",
  docs: "Documentation",
  data: "Databases",
  search: "Search",
  productivity: "Productivity",
  reasoning: "Reasoning",
};

/** Category order for display. */
export const CATEGORY_ORDER: ServerCategory[] = [
  "code",
  "design",
  "search",
  "data",
  "productivity",
  "docs",
  "reasoning",
];

/**
 * Find a catalog server by id.
 * Returns undefined if not found (custom server).
 */
export function findCatalogServer(id: string): CatalogServer | undefined {
  return MCP_CATALOG.find((s) => s.id === id);
}
