import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ipcMain, BrowserWindow } from "electron";
import { HttpBackend } from "./http-backend.mjs";
import { getPricingForModel } from "./pricing.mjs";
import { registerModels } from "./model-registry.mjs";

/**
 * Walk this.models (provider → models[]) and register every model's
 * context_length in the shared model registry. Called after any data
 * change — cache load, API refresh, external update.
 */
function registerAllModels(models) {
  for (const providerModels of Object.values(models)) {
    if (Array.isArray(providerModels)) {
      registerModels(providerModels);
    }
  }
}

const CACHE_DIR = path.join(os.homedir(), ".pane", "cache");
const CACHE_FILE = path.join(CACHE_DIR, "models.json");

/**
 * Look up pricing for a model ID from the pricing module.
 * Returns { input_cost, output_cost } in $/Mtok, or nulls if unknown.
 * Uses the dynamic pricing cache (OpenRouter → disk cache → cold-start seed).
 */
function lookupPricing(modelId) {
  return getPricingForModel(modelId);
}

/**
 * Enrich models with pricing data where missing.
 * If a model already has pricing (e.g. from OpenRouter API), keep it.
 * Otherwise, fill from the pricing module.
 */
function enrichWithPricing(models) {
  return models.map((m) => {
    if (m.input_cost != null && m.output_cost != null) return m;
    const pricing = lookupPricing(m.id);
    return {
      ...m,
      input_cost: m.input_cost ?? pricing.input_cost,
      output_cost: m.output_cost ?? pricing.output_cost,
    };
  });
}

class ModelManager {
  constructor() {
    this.models = {}; // provider -> models[]
    this.refreshTimer = null;
    this.backend = new HttpBackend(() => {});
    this.isRefreshing = false;
  }

  async initialize() {
    await this.loadCache();

    // Populate the shared model registry from cached data so budget
    // functions use API-reported context_length from the start.
    registerAllModels(this.models);

    // Notify renderer immediately with cached data so UI isn't empty on startup
    if (Object.keys(this.models).length > 0) {
      // Delay slightly to ensure windows are ready
      setTimeout(() => this.notifyRenderer(), 500);
    }

    this.startRefreshTimer();

    ipcMain.handle("get_models", async (_event, args) => {
      const { provider, forceRefresh } = args || {};
      if (forceRefresh) await this.refreshModels(provider);

      if (provider) return this.models[provider] || [];
      return this.models;
    });

    ipcMain.handle("refresh_all_models", async () => {
      return await this.refreshAllModels();
    });
  }

  async loadCache() {
    try {
      const content = await fs.readFile(CACHE_FILE, "utf-8");
      this.models = JSON.parse(content);
    } catch (err) {
      this.models = {};
    }
  }

  async saveCache() {
    try {
      await fs.mkdir(CACHE_DIR, { recursive: true });
      await fs.writeFile(CACHE_FILE, JSON.stringify(this.models, null, 2), "utf-8");
    } catch (err) {
      console.error("[model-manager] Failed to save model cache:", err);
    }
  }

  startRefreshTimer() {
    if (this.refreshTimer) clearInterval(this.refreshTimer);

    // Refresh all models every 1 hour
    this.refreshTimer = setInterval(() => {
      this.refreshAllModels();
    }, 1000 * 60 * 60);

    // Fetch immediately on startup — no delay
    this.refreshAllModels();
  }

  async refreshAllModels() {
    if (this.isRefreshing) return this.models;
    this.isRefreshing = true;

    console.log("[model-manager] Refreshing all models...");

    try {
      // CLI-backed providers (anthropic, gemini) also get prefetched from their
      // CLIs on startup. But if the user has HTTP API keys for them, we fetch
      // from the API too — richer data, and works without a CLI installed.
      // "anthropic" and "gemini" (no -api) are populated by CLI prefetch, not here.
      // "anthropic-api" and "gemini-api" are HTTP-fetched when user has API keys.
      const providers = ["openrouter", "deepseek", "gemini-api", "anthropic-api", "xiaomi"];
      const results = await Promise.allSettled(
        providers.map(p => this.refreshModels(p))
      );

      const changed = results.some(r => r.status === "fulfilled" && r.value === true);
      if (changed) {
        await this.saveCache();
        this.notifyRenderer();
      }

      // Retry providers that failed due to transient errors (not missing keys).
      const failedProviders = providers.filter((p, i) => {
        const r = results[i];
        return r.status === "rejected"
          && (!this.models[p] || this.models[p].length === 0);
      });
      if (failedProviders.length > 0) {
        console.log(`[model-manager] Retrying failed providers in 10s: ${failedProviders.join(", ")}`);
        setTimeout(async () => {
          let retryChanged = false;
          for (const p of failedProviders) {
            try {
              const changed = await this.refreshModels(p);
              if (changed) retryChanged = true;
            } catch {}
          }
          if (retryChanged) {
            await this.saveCache();
            this.notifyRenderer();
          }
        }, 10_000);
      }
    } finally {
      this.isRefreshing = false;
    }

    return this.models;
  }

  async refreshModels(provider) {
    try {
      let newModels = [];

      switch (provider) {
        case "openrouter":
          newModels = await this.backend.getOpenRouterModels();
          break;
        case "anthropic-api":
          newModels = await this.backend.getAnthropicModels();
          break;
        case "gemini-api":
          newModels = await this.backend.getGeminiModels();
          break;
        case "deepseek":
          newModels = await this.backend.getDeepSeekModels();
          break;
        case "xiaomi":
          newModels = await this.backend.getXiaomiModels();
          break;
        default:
          return false;
      }

      if (!newModels || newModels.length === 0) return false;

      // Enrich all models with pricing data where the API didn't provide it
      newModels = enrichWithPricing(newModels);

      const oldModelsStr = JSON.stringify(this.models[provider] || []);
      const newModelsStr = JSON.stringify(newModels);

      if (oldModelsStr !== newModelsStr) {
        this.models[provider] = newModels;
        registerAllModels(this.models); // update registry with fresh context_length data
        return true;
      }
    } catch (err) {
      console.error(`[model-manager] Failed to refresh models for ${provider}:`, err);
    }
    return false;
  }

  /**
   * Update models for a provider from an external source (e.g. CLI prefetch).
   * Enriches with pricing and persists.
   */
  updateModels(provider, models) {
    if (!models || models.length === 0) return false;
    const enriched = enrichWithPricing(models);
    const oldStr = JSON.stringify(this.models[provider] || []);
    const newStr = JSON.stringify(enriched);
    if (oldStr !== newStr) {
      this.models[provider] = enriched;
      registerAllModels(this.models); // update registry with context_length from CLI data
      return true;
    }
    return false;
  }

  notifyRenderer() {
    const windows = BrowserWindow.getAllWindows();
    for (const win of windows) {
      if (!win.isDestroyed()) {
        win.webContents.send("pane:models-updated", this.models);
      }
    }
  }
}

export const modelManager = new ModelManager();
