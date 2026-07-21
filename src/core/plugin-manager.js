// ═══ Plugin Manager ═══
import { readdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export class PluginManager {
  constructor() {
    this.plugins = new Map();   // languageId → plugin
    this.extMap = new Map();    // .ext → languageId
  }

  async loadAll() {
    // Встроенные плагины
    const builtins = ["javascript", "typescript", "python", "universal"];
    for (const name of builtins) {
      try {
        const mod = await import(`../../plugins/${name}.js`);
        const plugin = mod.default || mod.plugin;
        if (plugin?.languageId) {
          this.plugins.set(plugin.languageId, plugin);
          for (const ext of plugin.extensions || []) {
            this.extMap.set(ext, plugin.languageId);
          }
          console.error(`[plugin] ${plugin.languageId} (${plugin.extensions?.join(", ")})`);
        }
      } catch (e) {
        console.error(`[plugin] ${name} load error:`, e.message);
      }
    }

    // Внешние плагины из plugins/
    const extDir = join(__dirname, "..", "..", "plugins");
    if (existsSync(extDir)) {
      for (const f of readdirSync(extDir).filter(f => f.endsWith(".js") && !builtins.includes(f.replace(".js","")))) {
        try {
          const mod = await import(join(extDir, f));
          const p = mod.default || mod.plugin;
          if (p?.languageId) {
            this.plugins.set(p.languageId, p);
            for (const ext of p.extensions || []) this.extMap.set(ext, p.languageId);
            console.error(`[plugin] ext: ${p.languageId}`);
          }
        } catch (e) { console.error(`[plugin] ${f}:`, e.message); }
      }
    }
  }

  forFile(filePath) {
    const ext = "." + (filePath.split(".").pop() || "");
    return this.plugins.get(this.extMap.get(ext)) || this.plugins.get("universal");
  }

  get(id) { return this.plugins.get(id); }
  list() { return [...this.plugins.keys()]; }
}
