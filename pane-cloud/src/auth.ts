import type { Env, User } from "./types";

/**
 * Exchange a GitHub OAuth authorization code for an access token,
 * fetch the user's profile, and upsert into D1.
 */
export async function handleGitHubAuth(
  code: string,
  env: Env,
): Promise<{ access_token: string; user: User }> {
  // Exchange code for access token
  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
    }),
  });

  const tokenData = (await tokenRes.json()) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };

  if (!tokenData.access_token) {
    throw new Error(tokenData.error_description || tokenData.error || "GitHub token exchange failed");
  }

  const accessToken = tokenData.access_token;

  // Fetch user profile
  const userRes = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "Pane-Cloud/1.0",
    },
  });

  if (!userRes.ok) {
    throw new Error(`GitHub user fetch failed: ${userRes.status}`);
  }

  const ghUser = (await userRes.json()) as {
    id: number;
    login: string;
    avatar_url: string;
  };

  // Upsert user in D1
  const existing = await env.DB.prepare(
    "SELECT * FROM users WHERE github_id = ?",
  )
    .bind(ghUser.id)
    .first<User>();

  let user: User;

  if (existing) {
    // Update login/avatar in case they changed
    await env.DB.prepare(
      "UPDATE users SET github_login = ?, avatar_url = ?, updated_at = datetime('now') WHERE id = ?",
    )
      .bind(ghUser.login, ghUser.avatar_url, existing.id)
      .run();

    user = { ...existing, github_login: ghUser.login, avatar_url: ghUser.avatar_url };
  } else {
    // Generate user_secret — 32 random bytes, base64 encoded
    const secretBytes = new Uint8Array(32);
    crypto.getRandomValues(secretBytes);
    const userSecret = btoa(String.fromCharCode(...secretBytes));

    const result = await env.DB.prepare(
      `INSERT INTO users (github_id, github_login, avatar_url, user_secret)
       VALUES (?, ?, ?, ?)`,
    )
      .bind(ghUser.id, ghUser.login, ghUser.avatar_url, userSecret)
      .run();

    user = {
      id: result.meta.last_row_id as number,
      github_id: ghUser.id,
      github_login: ghUser.login,
      avatar_url: ghUser.avatar_url,
      user_secret: userSecret,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
  }

  return { access_token: accessToken, user };
}

/**
 * Validate a GitHub access token and return the associated Pane user.
 */
export async function authenticateRequest(
  request: Request,
  env: Env,
): Promise<User | null> {
  const auth = request.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  const token = auth.slice(7);

  // Validate token against GitHub
  const res = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "Pane-Cloud/1.0",
    },
  });

  if (!res.ok) return null;

  const ghUser = (await res.json()) as { id: number };

  // Look up in D1
  const user = await env.DB.prepare(
    "SELECT * FROM users WHERE github_id = ?",
  )
    .bind(ghUser.id)
    .first<User>();

  return user || null;
}
