import { App, Modal, Notice, PluginSettingTab, Setting } from "obsidian";
import type OcrImagePlugin from "./main";
import { NativeOcrEngine } from "./native-ocr";
import { installMacHelper } from "./native-helper";
import { clearModelCache, installRuntime, isRuntimeInstalled, prependPluginModulePath, uninstallRuntime } from "./native-manager";
import type { ModelTier } from "./local-ocr";

class ConfirmModal extends Modal {
  constructor(app: App, private title: string, private body: string, private action: () => Promise<void>) { super(app); }
  onOpen() {
    this.contentEl.createEl("h3", { text: this.title });
    this.contentEl.createEl("p", { text: this.body });
    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((button) => button.setButtonText("Delete").setWarning().onClick(() => { this.close(); void this.action(); }));
  }
  onClose() { this.contentEl.empty(); }
}

export class OcrImageSettingTab extends PluginSettingTab {
  private nativeStatus: string | null = null;
  private probedEngine?: NativeOcrEngine;
  constructor(app: App, private plugin: OcrImagePlugin) { super(app, plugin); }

  private async work(action: () => Promise<void>): Promise<void> {
    if (!this.plugin.beginWork()) return;
    try { await action(); }
    catch (error) {
      console.error("[text-lens] Settings action failed:", error);
      if (!this.plugin.unloaded) new Notice(`TextLens: ${error instanceof Error ? error.message : String(error)}`, 10000);
    } finally { this.plugin.endWork(); }
  }

  display(): void {
    const { containerEl } = this;
    const plugin = this.plugin;
    const settings = plugin.settings;
    const disabled = plugin.busy;
    containerEl.empty();
    new Setting(containerEl).setName("OCR engine").setHeading();
    new Setting(containerEl).setName("Recognition source / 识别来源")
      .setDesc("Recognition runs on this device. Engine failures never switch the selected source.")
      .addDropdown((drop) => drop.addOption("paddle", "PaddleOCR").addOption("native", "System native OCR / 系统原生 OCR")
        .setValue(settings.ocrSource).setDisabled(disabled).onChange((value) => this.work(async () => {
          settings.ocrSource = value as "paddle" | "native";
          await plugin.saveSettings();
          await plugin.resetEngine();
        })));

    const pluginDir = plugin.getPluginDir();
    if (settings.ocrSource === "native") {
      const engine = plugin.engine instanceof NativeOcrEngine ? plugin.engine : null;
      const platform = process.platform === "win32" ? "Windows.Media.Ocr" : process.platform === "darwin" ? "macOS Apple Vision" : `${process.platform} (unsupported; select PaddleOCR)`;
      containerEl.createEl("p", { cls: "setting-item-description", text:
        `${platform}. Experimental: platform acceptance is pending. Native OCR processes one image at a time.` });
      if (engine && this.probedEngine !== engine) {
        this.probedEngine = engine;
        this.nativeStatus = "Checking installed languages and helper availability…";
        void engine.initialize().then(() => {
          if (plugin.engine === engine) this.nativeStatus = "System engine ready (platform acceptance pending).";
        }, (error) => {
          if (plugin.engine === engine) this.nativeStatus = error instanceof Error ? error.message : String(error);
        })
          .then(() => { if (plugin.engine === engine && !plugin.unloaded) this.display(); });
      }
      containerEl.createEl("p", { cls: "setting-item-description", text: this.nativeStatus ?? "Engine idle." });
      const info = engine?.info;
      const defaultDescription = process.platform !== "win32" && process.platform !== "darwin"
        ? "Select PaddleOCR on this platform."
        : process.platform === "win32"
        ? `System default uses the user's configured languages, without image language detection. Current language: ${info?.defaultLanguage ?? "unavailable"}.`
        : info?.autoDetection
          ? "System default enables Vision language detection."
          : `System default uses the first supported preferred language, otherwise English. Current language: ${info?.defaultLanguage ?? "unknown until helper is installed"}.`;
      new Setting(containerEl).setName("Native language").setDesc(defaultDescription)
        .addDropdown((drop) => {
          drop.addOption("auto", "System default / 系统默认");
          for (const language of info?.languages ?? []) drop.addOption(language, language);
          if (settings.nativeLanguage !== "auto" && !info?.languages.includes(settings.nativeLanguage)) drop.addOption(settings.nativeLanguage, `${settings.nativeLanguage} (unavailable)`);
          drop.setValue(settings.nativeLanguage).setDisabled(disabled || !info).onChange((value) => this.work(async () => {
            settings.nativeLanguage = value;
            await plugin.saveSettings();
            await plugin.resetEngine();
          }));
        });
      if (info?.maxImageDimension) containerEl.createEl("p", { cls: "setting-item-description", text: `Maximum image dimension: ${info.maxImageDimension}px. Larger images are scaled proportionally; the batch reports affected images.` });
      if (process.platform === "darwin") {
        new Setting(containerEl).setName("Install / reinstall native helper")
          .setDesc(`Downloads the Apple Vision helper for plugin ${plugin.manifest.version} (${process.arch}), verifies SHA-256 and version, then installs it. No Swift tools are needed; subsequent recognition works offline.`)
          .addButton((button) => button.setButtonText("Install / reinstall").setDisabled(disabled).onClick(() => this.work(async () => {
            await installMacHelper(pluginDir, plugin.manifest.version, (message) => button.setButtonText(message), undefined, plugin.lifetime.signal);
            if (plugin.unloaded) return;
            await plugin.resetEngine();
            new Notice("Native OCR helper installed.", 5000);
          })));
      }
    } else {
      const installed = isRuntimeInstalled(pluginDir);
      containerEl.createEl("p", { cls: "setting-item-description", text: installed
        ? plugin.engine.ready ? "Runtime installed; PaddleOCR ready." : "Runtime installed; engine loads on first use."
        : "Runtime not installed. Click Setup to download (~40 MB)." });
      if (!installed) new Setting(containerEl).setName("Setup local runtime")
        .setDesc("Downloads ONNX Runtime and canvas binaries for PaddleOCR.")
        .addButton((button) => button.setButtonText("Setup").setCta().setDisabled(disabled).onClick(() => this.work(async () => {
          await installRuntime(pluginDir, plugin.manifest.version, (progress) => button.setButtonText(progress.message));
          prependPluginModulePath(pluginDir);
          if (!plugin.unloaded) new Notice("PaddleOCR runtime installed.", 5000);
        })));
      new Setting(containerEl).setName("Model tier")
        .setDesc("Tiny (~5 MB), Small (~25 MB, default), Medium (~60 MB). Models are cached at ~/.cache/ppu-paddle-ocr/.")
        .addDropdown((drop) => drop.addOption("tiny", "Tiny (fastest)").addOption("small", "Small (balanced)")
          .addOption("medium", "Medium (most accurate)").setValue(settings.localModelTier).setDisabled(disabled)
          .onChange((value) => this.work(async () => {
            settings.localModelTier = value as ModelTier;
            await plugin.saveSettings();
            await plugin.resetEngine();
          })));
      if (installed) {
        const ready = plugin.engine.ready;
        new Setting(containerEl).setName(ready ? "Unload local engine" : "Load local engine")
          .setDesc("Control the ONNX inference session memory (~200 MB).")
          .addButton((button) => button.setButtonText(ready ? "Unload" : "Load").setDisabled(disabled).onClick(() => this.work(async () => {
            if (ready) await plugin.resetEngine();
            else await plugin.engine.initialize();
          })));
        new Setting(containerEl).setName("Delete runtime files").setDesc("Unload PaddleOCR and remove its downloaded runtime. Setup can reinstall it.")
          .addButton((button) => button.setButtonText("Delete").setWarning().setDisabled(disabled).onClick(() => {
            new ConfirmModal(this.app, "Delete runtime files?", "Remove PaddleOCR runtime files from this plugin's directory?", () => this.work(async () => {
              await plugin.resetEngine();
              await uninstallRuntime(pluginDir);
              new Notice("Runtime files deleted.");
            })).open();
          }));
      }
      new Setting(containerEl).setName("Clear model cache").setDesc("Delete downloaded model weights. PaddleOCR downloads them again on next use.")
        .addButton((button) => button.setButtonText("Clear").setWarning().setDisabled(disabled).onClick(() => {
          new ConfirmModal(this.app, "Clear model cache?", "Delete weights from ~/.cache/ppu-paddle-ocr/?", () => this.work(async () => {
            await plugin.resetEngine();
            const result = await clearModelCache();
            new Notice(result.deleted ? "Model cache cleared." : "No model cache found.");
          })).open();
        }));
      new Setting(containerEl).setName("Max concurrency").setDesc("PaddleOCR only: images processed in parallel (1–20). Native OCR always uses 1.")
        .addText((text) => text.setValue(String(settings.maxConcurrency)).setDisabled(disabled).onChange(async (raw) => {
          if (plugin.busy) return;
          const count = Number.parseInt(raw, 10);
          if (!Number.isFinite(count)) return;
          settings.maxConcurrency = Math.max(1, Math.min(20, count));
          await plugin.saveSettings();
        }));
    }

    new Setting(containerEl).setName("Output").setHeading();
    new Setting(containerEl).setName("Output format").setDesc("Insert text below each image.")
      .addDropdown((drop) => drop.addOption("callout", "Obsidian callout").addOption("codeblock", "Fenced OCR block")
        .setValue(settings.outputFormat).setDisabled(disabled).onChange(async (value) => {
          if (plugin.busy) return;
          settings.outputFormat = value as "callout" | "codeblock";
          await plugin.saveSettings();
        }));
    new Setting(containerEl).setName("Skip already-processed images").setDesc("Notes with existing OCR results automatically rerun all images.")
      .addToggle((toggle) => toggle.setValue(settings.skipAlreadyProcessed).setDisabled(disabled).onChange(async (value) => {
        if (plugin.busy) return;
        settings.skipAlreadyProcessed = value;
        await plugin.saveSettings();
      }));
    new Setting(containerEl).setName("Merge wrapped lines").setDesc("Join visual soft wraps; keep sentence endings and list items separate.")
      .addToggle((toggle) => toggle.setValue(settings.useTextRefinement).setDisabled(disabled).onChange(async (value) => {
        if (plugin.busy) return;
        settings.useTextRefinement = value;
        await plugin.saveSettings();
      }));
    new Setting(containerEl).setName("Diagnostics").setHeading();
    new Setting(containerEl).setName("Developer mode").setDesc("Log raw OCR lines, including Windows lines before Han-space normalization, to the console (Ctrl+Shift+I).")
      .addToggle((toggle) => toggle.setValue(settings.devMode).setDisabled(disabled).onChange((value) => this.work(async () => {
        settings.devMode = value;
        await plugin.saveSettings();
        await plugin.resetEngine();
      })));
  }
}
