import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ipcMain, BrowserWindow } from "electron";
import { HttpBackend } from "./http-backend.mjs";

const CACHE_DIR = path.join(os.homedir(), ".pane", "cache");
const CACHE_FILE = path.join(CACHE_DIR, "models.json");

class ModelManager {
  constructor() {
    this.models = {}; // provider -> models[]
    this.refreshTimer = null;
    this.backend = new HttpBackend(() => {});
    this.isRefreshing = false;
  }

  async initialize() {
    await this.loadCache();
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

    // Initial refresh after a short delay
    setTimeout(() => this.refreshAllModels(), 5000);
  }

  async refreshAllModels() {
    if (this.isRefreshing) return this.models;
    this.isRefreshing = true;
    
    console.log("[model-manager] Refreshing all models in background...");
    
    try {
      const providers = ["openrouter", "anthropic", "gemini", "deepseek"];
      const results = await Promise.allSettled(
        providers.map(p => this.refreshModels(p))
      );
      
      const changed = results.some(r => r.status === "fulfilled" && r.value === true);
      if (changed) {
        await this.saveCache();
        this.notifyRenderer();
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
        case "anthropic":
          // Anthropic models API is relatively new and may require specific headers/keys
          // For now we keep it as-is or implement if they have a stable public endpoint
          // For now return empty to not overwrite hardcoded unless we implement it properly
          return false; 
        case "gemini":
          // Gemini models API: https://generativelanguage.googleapis.com/v1beta/models
          // Needs implementation in HttpBackend
          return false;
        default:
          return false;
      }

      if (!newModels || newModels.length === 0) return false;

      const oldModelsStr = JSON.stringify(this.models[provider] || []);
      const newModelsStr = JSON.stringify(newModels);

      if (oldModelsStr !== newModelsStr) {
        this.models[provider] = newModels;
        return true;
      }
    } catch (err) {
      console.error(`[model-manager] Failed to refresh models for ${provider}:`, err);
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
