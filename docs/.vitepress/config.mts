import { defineConfig } from "vitepress";

export default defineConfig({
  title: "Pane",
  description: "An AI-native development environment for macOS",
  lang: "en-US",
  base: "/",
  lastUpdated: true,
  cleanUrls: true,

  head: [
    ["link", { rel: "icon", href: "/favicon.svg" }],
  ],

  themeConfig: {
    logo: "/favicon.svg",

    nav: [
      { text: "Guide", link: "/guide/getting-started" },
      { text: "Reference", link: "/reference/keyboard-shortcuts" },
      {
        text: "GitHub",
        link: "https://github.com/GnSultan/Pane",
      },
    ],

    sidebar: {
      "/guide/": [
        {
          text: "Guide",
          items: [
            { text: "Getting started", link: "/guide/getting-started" },
            { text: "Modes", link: "/guide/modes" },
            { text: "Brain", link: "/guide/brain" },
          ],
        },
      ],
      "/reference/": [
        {
          text: "Reference",
          items: [
            { text: "Keyboard shortcuts", link: "/reference/keyboard-shortcuts" },
            { text: "Providers", link: "/reference/providers" },
          ],
        },
      ],
    },

    socialLinks: [
      { icon: "github", link: "https://github.com/GnSultan/Pane" },
    ],

    footer: {
      message: "Built by <a href='https://aslamabdul.com' target='_blank'>Aslam Abdul</a>",
      copyright: "MIT License",
    },

    search: {
      provider: "local",
    },
  },
});
