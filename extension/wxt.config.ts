import { defineConfig } from "wxt";

export default defineConfig({
  extensionApi: "chrome",
  modules: ["@wxt-dev/module-react"],
  vite: () => ({
    envDir: "..",
  }),
  manifest: {
    name: "Interview Intelligence Agent",
    description:
      "AI-powered real-time interview copilot for Google Meet — transcribes, analyzes, and suggests follow-up questions.",
    version: "1.0.0",
    permissions: ["activeTab", "sidePanel", "storage", "tabs", "tabCapture", "offscreen"],
    host_permissions: ["https://meet.google.com/*"],
    side_panel: {
      default_path: "sidepanel.html",
    },
  },
});
