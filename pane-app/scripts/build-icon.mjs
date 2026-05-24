#!/usr/bin/env node
/**
 * build-icon.mjs — regenerates all Pane app icon assets.
 *
 * Produces:
 *   build/icon-bg.png        — solid dark background tile (1024×1024)
 *   build/icon-fg.png        — starburst on transparent (1024×1024)
 *   build/icon-1024.png      — composite for xcassets (1024×1024)
 *   build/AppIcon.xcassets/  — all sized slots for actool
 *   build/Assets.car         — compiled asset catalog (macOS 26 Tahoe, no squircle jail)
 *   build/icon.icns          — legacy fallback for macOS < 26
 *   build/icon.png           — fallback PNG
 *   electron/assets/icon.png         — runtime default dock icon
 *   electron/assets/icon-dark.png    — runtime dark/ink dock icon
 *   electron/assets/icon-glass.png   — runtime glass/clear dock icon (transparent bg)
 *
 * Run: node scripts/build-icon.mjs
 * Requires: Python 3 + Pillow, Xcode (actool)
 */

import { execSync, execFileSync } from "node:child_process";
import { mkdirSync, copyFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const build = resolve(root, "build");
const assets = resolve(root, "electron/assets");

const MARGIN = 100;

console.log("→ Generating icon layers…");
execFileSync("python3", ["-c", `
from PIL import Image
import os

SIZE = 1024
MARGIN = 100
src = Image.open("${resolve(root, "..", "Pane logo icon.png").replace(/\\/g, "\\\\")}").convert("RGBA")
# Crop to actual starburst bounding box
bbox = src.split()[3].getbbox()
cx = (bbox[0] + bbox[2]) // 2
cy = (bbox[1] + bbox[3]) // 2
half = max(bbox[2] - bbox[0], bbox[3] - bbox[1]) // 2 + 20
cropped = src.crop((cx - half, cy - half, cx + half, cy + half))
LOGO_SIZE = SIZE - MARGIN * 2
logo = cropped.resize((LOGO_SIZE, LOGO_SIZE), Image.LANCZOS)
_, _, _, alpha = logo.split()
WARM = (216, 213, 206, 255)
BG   = (28, 27, 26, 255)
# Background layer
bg_layer = Image.new("RGBA", (SIZE, SIZE), BG)
bg_layer.save("${build}/icon-bg.png")
# Foreground layer — starburst on transparent
fg_layer = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
star = Image.composite(Image.new("RGBA", (LOGO_SIZE, LOGO_SIZE), WARM), Image.new("RGBA", (LOGO_SIZE, LOGO_SIZE), (0, 0, 0, 0)), alpha)
fg_layer.paste(star, (${MARGIN}, ${MARGIN}), star)
fg_layer.save("${build}/icon-fg.png")
# Composite
icon = Image.alpha_composite(bg_layer, fg_layer)
icon.save("${build}/icon-1024.png")
# Sized slots for xcassets
iconset = "${build}/AppIcon.xcassets/AppIcon.appiconset"
os.makedirs(iconset, exist_ok=True)
for fname, size in [("icon-16.png",16),("icon-32.png",32),("icon-64.png",64),("icon-128.png",128),("icon-256.png",256),("icon-512.png",512),("icon-1024.png",1024)]:
    icon.resize((size, size), Image.LANCZOS).save(os.path.join(iconset, fname))
# Runtime dock icons
bg_semi = Image.new("RGBA", (SIZE, SIZE), (28, 27, 26, 216))
fg = fg_layer
Image.alpha_composite(bg_semi, fg).save("${assets}/icon.png")
Image.alpha_composite(Image.new("RGBA", (SIZE, SIZE), (28, 27, 26, 255)), fg).save("${assets}/icon-dark.png")
fg.save("${assets}/icon-glass.png")
icon.save("${build}/icon.png")
print("Layers done")
`], { stdio: "inherit" });

console.log("→ Writing Contents.json…");
const contentsJson = {
  images: [
    { idiom: "mac", scale: "1x", size: "16x16",   filename: "icon-16.png"   },
    { idiom: "mac", scale: "2x", size: "16x16",   filename: "icon-32.png"   },
    { idiom: "mac", scale: "1x", size: "32x32",   filename: "icon-32.png"   },
    { idiom: "mac", scale: "2x", size: "32x32",   filename: "icon-64.png"   },
    { idiom: "mac", scale: "1x", size: "128x128", filename: "icon-128.png"  },
    { idiom: "mac", scale: "2x", size: "128x128", filename: "icon-256.png"  },
    { idiom: "mac", scale: "1x", size: "256x256", filename: "icon-256.png"  },
    { idiom: "mac", scale: "2x", size: "256x256", filename: "icon-512.png"  },
    { idiom: "mac", scale: "1x", size: "512x512", filename: "icon-512.png"  },
    { idiom: "mac", scale: "2x", size: "512x512", filename: "icon-1024.png" },
  ],
  info: { author: "xcode", version: 1 },
};
writeFileSync(
  resolve(build, "AppIcon.xcassets/AppIcon.appiconset/Contents.json"),
  JSON.stringify(contentsJson, null, 2)
);

console.log("→ Compiling Assets.car with actool…");
execFileSync("xcrun", [
  "actool", "AppIcon.xcassets",
  "--compile", ".",
  "--output-format", "human-readable-text",
  "--notices", "--warnings", "--errors",
  "--output-partial-info-plist", "/tmp/pane-icon.plist",
  "--app-icon", "AppIcon",
  "--include-all-app-icons",
  "--enable-on-demand-resources", "NO",
  "--development-region", "en",
  "--target-device", "mac",
  "--minimum-deployment-target", "14.0",
  "--platform", "macosx",
], { cwd: build, stdio: "inherit" });

// actool emits AppIcon.icns — use it as the legacy fallback
copyFileSync(resolve(build, "AppIcon.icns"), resolve(build, "icon.icns"));

console.log("✓ Done:");
console.log("  build/Assets.car        — macOS 26 asset catalog (prevents squircle jail)");
console.log("  build/icon.icns         — legacy fallback < macOS 26");
console.log("  electron/assets/icon*.png — runtime dock icon variants");
