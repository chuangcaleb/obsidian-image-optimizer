'use strict';

var node_child_process = require('node:child_process');
var node_crypto = require('node:crypto');
var path = require('node:path');
var node_util = require('node:util');
var obsidian = require('obsidian');

const DEFAULT_SETTINGS = {
    runtimeAbsolutePath: '',
    compressionScriptAbsolutePath: '',
    isTriggerOnCreate: true,
};
const execFileAsync = node_util.promisify(node_child_process.execFile);
function isImage(file) {
    return /\.(png|jpe?g|webp)$/i.test(file.path);
}
function slugify(name) {
    return name
        .toLowerCase()
        .replaceAll(/[^a-z\d]+/g, '-')
        .replaceAll(/^-+|-+$/g, '');
}
class MyPlugin extends obsidian.Plugin {
    async onload() {
        // Manual command from Command Palette
        this.addCommand({
            id: 'rename-active-image',
            name: 'Optimize active image file',
            callback: async () => {
                const file = this.app.workspace.getActiveFile();
                if (!file) {
                    new obsidian.Notice('Image Optimizer: No active file');
                    return;
                }
                if (!isImage(file)) {
                    new obsidian.Notice('Image Optimizer: Active file is not an image');
                    return;
                }
                await this.processFile(file);
            },
        });
        // This adds a settings tab so the user can configure various aspects of the plugin
        await this.loadSettings();
        this.imageHandler = new ImageCreateHandler(this.app, this.processFile.bind(this));
        this.applySettings();
        this.addSettingTab(new SampleSettingTab(this));
    }
    async loadSettings() {
        const loaded = (await this.loadData());
        this.settings = {
            ...DEFAULT_SETTINGS,
            ...loaded,
        };
    }
    async saveSettings() {
        await this.saveData(this.settings);
    }
    applySettings() {
        if (this.settings.isTriggerOnCreate) {
            this.imageHandler.enable();
        }
        else {
            this.imageHandler.disable();
        }
    }
    async updateSettings(newSettings) {
        Object.assign(this.settings, newSettings);
        await this.saveSettings();
        this.applySettings();
    }
    onunload() {
        this.imageHandler.disable();
    }
    /* -------------------- only run after metadata ready --------------------- */
    // file renaming will be partial if metadata cache has not refreshed
    async delay(ms) {
        return new Promise((resolve) => {
            setTimeout(resolve, ms);
        });
    }
    async waitForMetadataChange(file) {
        return new Promise((resolve) => {
            const onChange = (changedFile) => {
                if (changedFile.path === file.path) {
                    this.app.metadataCache.off('changed', onChange);
                    resolve();
                }
            };
            this.app.metadataCache.on('changed', onChange);
        });
    }
    async waitForMetadataReady(file, timeout = 5000) {
        const start = Date.now();
        // Use recursion to avoid 'await in loop'
        const check = async () => {
            const fileCache = this.app.metadataCache.getFileCache(file);
            const backlinks = this.app.metadataCache.resolvedLinks[file.path];
            if (fileCache && backlinks) {
                return;
            }
            if (Date.now() - start > timeout) {
                return;
            }
            // Wait either for delay or metadata change event, whichever comes first
            await Promise.race([
                this.delay(100),
                this.waitForMetadataChange(file),
            ]);
            return check();
        };
        await check();
    }
    getVaultBasePath() {
        const adapter = this.app.vault.adapter;
        if (adapter instanceof obsidian.FileSystemAdapter) {
            return adapter.getBasePath(); // absolute path to vault
        }
        return undefined;
    }
    /* ------------------------------- - ----------------------------------- */
    async processFile(file) {
        new obsidian.Notice(`Image Optimizer: Waiting for metadata cache...`);
        // await fresh metadata before starting anything
        await this.waitForMetadataReady(file);
        const oldName = file.name;
        // Skip if filename already ends with a slug-hash pattern
        const extension = file.extension.toLowerCase();
        const basename = file.basename;
        const fullName = `${basename}.${extension}`;
        if (/-[a-f\d]{8}\.[a-z]{2,4}$/i.test(fullName)) {
            new obsidian.Notice(`Image Optimizer: Skipping "${fullName}": already hashed`);
            return;
        }
        /* ---------------------------- compress -------------------------------- */
        if (!this.settings.runtimeAbsolutePath) {
            new obsidian.Notice('Image Optimizer: Missing runtime absolute path. See settings.');
            return;
        }
        if (!this.settings.compressionScriptAbsolutePath) {
            new obsidian.Notice('Image Optimizer: Missing compression script absolute path. See settings.');
            return;
        }
        // Get absolute file path
        const basePath = this.getVaultBasePath();
        if (!basePath)
            throw new Error('Should never reach here');
        const absoluteFilePath = path.join(basePath, file.path);
        // run external compression script
        // since `sharp` cannot run in Obsidian native bindings, or something
        try {
            // TODO: allow custom compression args
            await execFileAsync(this.settings.runtimeAbsolutePath, [
                this.settings.compressionScriptAbsolutePath,
                absoluteFilePath,
            ]);
        }
        catch (error) {
            console.error('Error during compression:', error);
            new obsidian.Notice('Image Optimizer: Image compression failed.');
        }
        // Find new compressed file
        const compressedRelativePath = obsidian.normalizePath(`${file.path.slice(0, -extension.length - 1)}.temp`);
        const compressedFile = this.app.vault.getAbstractFileByPath(compressedRelativePath);
        if (!(compressedFile instanceof obsidian.TFile) || !compressedFile) {
            new obsidian.Notice('Image Optimizer: Compressed file not found in vault.');
            return;
        }
        /* ------------------------------ hash ---------------------------------- */
        const arrayBuffer = await this.app.vault.readBinary(compressedFile);
        const hash = node_crypto.createHash('md5')
            .update(Buffer.from(arrayBuffer))
            .digest('hex')
            .slice(0, 8);
        /* ------------------------------ slug ---------------------------------- */
        const slug = slugify(basename);
        // const newName = `${slug}-${hash}.${extension}`;
        const newName = `${slug}-${hash}.webp`;
        // get new route
        const parentPath = (() => {
            if (file.parent?.path === '/') {
                return '.';
            }
            return file.parent?.path ?? '';
        })();
        const newPath = path.join(parentPath, newName);
        /* ------------------------------ write --------------------------------- */
        // Skip if a file with the same name already exists
        const maybeExisting = this.app.vault.getAbstractFileByPath(newPath);
        if (maybeExisting) {
            new obsidian.Notice(`Image Optimizer: Skipped - "${newName}" already ends in an 8-character hash. Remove that suffix and try again?`);
            return;
        }
        // replace file
        await this.app.fileManager.renameFile(file, newPath);
        await this.app.vault.delete(file);
        await this.app.fileManager.renameFile(compressedFile, newPath);
        // Get the newly created file as a TFile
        const newFile = this.app.vault.getAbstractFileByPath(newPath);
        if (!(newFile instanceof obsidian.TFile)) {
            // should not reach here
            new obsidian.Notice(`Image Optimizer: Failed to find new file - "${newName}"`);
            return;
        }
        new obsidian.Notice(`Image Optimizer: Renamed ${oldName} → ${newName}`, 3000);
    }
}
class SampleSettingTab extends obsidian.PluginSettingTab {
    constructor(plugin) {
        super(plugin.app, plugin);
        this.plugin = plugin;
    }
    display() {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.createEl('h2', { text: 'Image Plugin Settings' });
        new obsidian.Setting(containerEl)
            .setName('Trigger automatically')
            .setDesc('Automatically process new image files added to the vault.')
            .addToggle((toggle) => toggle
            .setValue(this.plugin.settings.isTriggerOnCreate)
            .onChange(async (value) => {
            this.plugin.settings.isTriggerOnCreate = value;
            await this.plugin.saveSettings();
            this.plugin.applySettings();
        }));
        new obsidian.Setting(containerEl)
            .setName('Absolute path to runtime')
            .addText((text) => text
            .setPlaceholder('Enter value')
            .setValue(this.plugin.settings.runtimeAbsolutePath)
            .onChange(async (value) => {
            this.plugin.settings.runtimeAbsolutePath = value;
            await this.plugin.saveSettings();
        }));
        new obsidian.Setting(containerEl)
            .setName('Absolute path to compression script')
            .addTextArea((text) => text
            .setPlaceholder('Enter value')
            .setValue(this.plugin.settings.compressionScriptAbsolutePath)
            .onChange(async (value) => {
            this.plugin.settings.compressionScriptAbsolutePath =
                value;
            await this.plugin.saveSettings();
        }));
    }
}
class ImageCreateHandler {
    constructor(app, processFile) {
        this.app = app;
        this.processFile = processFile;
        this.eventRef = undefined;
    }
    enable() {
        if (this.eventRef)
            return;
        this.eventRef = this.app.vault.on('create', (file) => {
            if (!(file instanceof obsidian.TFile))
                return;
            if (!isImage(file))
                return;
            // TODO: better detection for optimized images?
            if (file.extension === 'temp')
                return;
            void this.processFile(file);
        });
    }
    disable() {
        if (this.eventRef) {
            this.app.vault.offref(this.eventRef);
            this.eventRef = undefined;
        }
    }
}

module.exports = MyPlugin;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWFpbi5qcyIsInNvdXJjZXMiOlsiLi4vLi4vLi4vLi4vc3JjL21haW4udHMiXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHtleGVjRmlsZX0gZnJvbSAnbm9kZTpjaGlsZF9wcm9jZXNzJztcbmltcG9ydCB7Y3JlYXRlSGFzaH0gZnJvbSAnbm9kZTpjcnlwdG8nO1xuaW1wb3J0IHBhdGggZnJvbSAnbm9kZTpwYXRoJztcbmltcG9ydCB7cHJvbWlzaWZ5fSBmcm9tICdub2RlOnV0aWwnO1xuaW1wb3J0IHtcblx0dHlwZSBBcHAsXG5cdHR5cGUgRXZlbnRSZWYsXG5cdEZpbGVTeXN0ZW1BZGFwdGVyLFxuXHRNb2RhbCxcblx0bm9ybWFsaXplUGF0aCxcblx0Tm90aWNlLFxuXHRQbHVnaW4sXG5cdFBsdWdpblNldHRpbmdUYWIsXG5cdFNldHRpbmcsXG5cdFRGaWxlLFxufSBmcm9tICdvYnNpZGlhbic7XG5cbnR5cGUgUGx1Z2luU2V0dGluZ3MgPSB7XG5cdHJ1bnRpbWVBYnNvbHV0ZVBhdGg6IHN0cmluZztcblx0Y29tcHJlc3Npb25TY3JpcHRBYnNvbHV0ZVBhdGg6IHN0cmluZztcblx0aXNUcmlnZ2VyT25DcmVhdGU6IGJvb2xlYW47XG59O1xuXG5jb25zdCBERUZBVUxUX1NFVFRJTkdTOiBQbHVnaW5TZXR0aW5ncyA9IHtcblx0cnVudGltZUFic29sdXRlUGF0aDogJycsXG5cdGNvbXByZXNzaW9uU2NyaXB0QWJzb2x1dGVQYXRoOiAnJyxcblx0aXNUcmlnZ2VyT25DcmVhdGU6IHRydWUsXG59O1xuXG5jb25zdCBleGVjRmlsZUFzeW5jID0gcHJvbWlzaWZ5KGV4ZWNGaWxlKTtcblxuZnVuY3Rpb24gaXNJbWFnZShmaWxlOiBURmlsZSk6IGJvb2xlYW4ge1xuXHRyZXR1cm4gL1xcLihwbmd8anBlP2d8d2VicCkkL2kudGVzdChmaWxlLnBhdGgpO1xufVxuXG5mdW5jdGlvbiBzbHVnaWZ5KG5hbWU6IHN0cmluZyk6IHN0cmluZyB7XG5cdHJldHVybiBuYW1lXG5cdFx0LnRvTG93ZXJDYXNlKClcblx0XHQucmVwbGFjZUFsbCgvW15hLXpcXGRdKy9nLCAnLScpXG5cdFx0LnJlcGxhY2VBbGwoL14tK3wtKyQvZywgJycpO1xufVxuXG5leHBvcnQgZGVmYXVsdCBjbGFzcyBNeVBsdWdpbiBleHRlbmRzIFBsdWdpbiB7XG5cdHNldHRpbmdzOiBQbHVnaW5TZXR0aW5ncztcblx0aW1hZ2VIYW5kbGVyOiBJbWFnZUNyZWF0ZUhhbmRsZXI7XG5cblx0YXN5bmMgb25sb2FkKCkge1xuXHRcdC8vIE1hbnVhbCBjb21tYW5kIGZyb20gQ29tbWFuZCBQYWxldHRlXG5cdFx0dGhpcy5hZGRDb21tYW5kKHtcblx0XHRcdGlkOiAncmVuYW1lLWFjdGl2ZS1pbWFnZScsXG5cdFx0XHRuYW1lOiAnT3B0aW1pemUgYWN0aXZlIGltYWdlIGZpbGUnLFxuXHRcdFx0Y2FsbGJhY2s6IGFzeW5jICgpID0+IHtcblx0XHRcdFx0Y29uc3QgZmlsZSA9IHRoaXMuYXBwLndvcmtzcGFjZS5nZXRBY3RpdmVGaWxlKCk7XG5cblx0XHRcdFx0aWYgKCFmaWxlKSB7XG5cdFx0XHRcdFx0bmV3IE5vdGljZSgnSW1hZ2UgT3B0aW1pemVyOiBObyBhY3RpdmUgZmlsZScpO1xuXHRcdFx0XHRcdHJldHVybjtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdGlmICghaXNJbWFnZShmaWxlKSkge1xuXHRcdFx0XHRcdG5ldyBOb3RpY2UoJ0ltYWdlIE9wdGltaXplcjogQWN0aXZlIGZpbGUgaXMgbm90IGFuIGltYWdlJyk7XG5cdFx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0YXdhaXQgdGhpcy5wcm9jZXNzRmlsZShmaWxlKTtcblx0XHRcdH0sXG5cdFx0fSk7XG5cdFx0Ly8gVGhpcyBhZGRzIGEgc2V0dGluZ3MgdGFiIHNvIHRoZSB1c2VyIGNhbiBjb25maWd1cmUgdmFyaW91cyBhc3BlY3RzIG9mIHRoZSBwbHVnaW5cblx0XHRhd2FpdCB0aGlzLmxvYWRTZXR0aW5ncygpO1xuXHRcdHRoaXMuaW1hZ2VIYW5kbGVyID0gbmV3IEltYWdlQ3JlYXRlSGFuZGxlcihcblx0XHRcdHRoaXMuYXBwLFxuXHRcdFx0dGhpcy5wcm9jZXNzRmlsZS5iaW5kKHRoaXMpIGFzIHR5cGVvZiB0aGlzLnByb2Nlc3NGaWxlLFxuXHRcdCk7XG5cdFx0dGhpcy5hcHBseVNldHRpbmdzKCk7XG5cdFx0dGhpcy5hZGRTZXR0aW5nVGFiKG5ldyBTYW1wbGVTZXR0aW5nVGFiKHRoaXMpKTtcblx0fVxuXG5cdGFzeW5jIGxvYWRTZXR0aW5ncygpIHtcblx0XHRjb25zdCBsb2FkZWQgPSAoYXdhaXQgdGhpcy5sb2FkRGF0YSgpKSBhcyBQYXJ0aWFsPFBsdWdpblNldHRpbmdzPjtcblx0XHR0aGlzLnNldHRpbmdzID0ge1xuXHRcdFx0Li4uREVGQVVMVF9TRVRUSU5HUyxcblx0XHRcdC4uLmxvYWRlZCxcblx0XHR9O1xuXHR9XG5cblx0YXN5bmMgc2F2ZVNldHRpbmdzKCkge1xuXHRcdGF3YWl0IHRoaXMuc2F2ZURhdGEodGhpcy5zZXR0aW5ncyk7XG5cdH1cblxuXHRhcHBseVNldHRpbmdzKCkge1xuXHRcdGlmICh0aGlzLnNldHRpbmdzLmlzVHJpZ2dlck9uQ3JlYXRlKSB7XG5cdFx0XHR0aGlzLmltYWdlSGFuZGxlci5lbmFibGUoKTtcblx0XHR9IGVsc2Uge1xuXHRcdFx0dGhpcy5pbWFnZUhhbmRsZXIuZGlzYWJsZSgpO1xuXHRcdH1cblx0fVxuXG5cdGFzeW5jIHVwZGF0ZVNldHRpbmdzKG5ld1NldHRpbmdzOiBQYXJ0aWFsPFBsdWdpblNldHRpbmdzPikge1xuXHRcdE9iamVjdC5hc3NpZ24odGhpcy5zZXR0aW5ncywgbmV3U2V0dGluZ3MpO1xuXHRcdGF3YWl0IHRoaXMuc2F2ZVNldHRpbmdzKCk7XG5cdFx0dGhpcy5hcHBseVNldHRpbmdzKCk7XG5cdH1cblxuXHRvbnVubG9hZCgpIHtcblx0XHR0aGlzLmltYWdlSGFuZGxlci5kaXNhYmxlKCk7XG5cdH1cblxuXHQvKiAtLS0tLS0tLS0tLS0tLS0tLS0tLSBvbmx5IHJ1biBhZnRlciBtZXRhZGF0YSByZWFkeSAtLS0tLS0tLS0tLS0tLS0tLS0tLS0gKi9cblx0Ly8gZmlsZSByZW5hbWluZyB3aWxsIGJlIHBhcnRpYWwgaWYgbWV0YWRhdGEgY2FjaGUgaGFzIG5vdCByZWZyZXNoZWRcblxuXHRwcml2YXRlIGFzeW5jIGRlbGF5KG1zOiBudW1iZXIpOiBQcm9taXNlPHZvaWQ+IHtcblx0XHRyZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUpID0+IHtcblx0XHRcdHNldFRpbWVvdXQocmVzb2x2ZSwgbXMpO1xuXHRcdH0pO1xuXHR9XG5cblx0cHJpdmF0ZSBhc3luYyB3YWl0Rm9yTWV0YWRhdGFDaGFuZ2UoZmlsZTogVEZpbGUpOiBQcm9taXNlPHZvaWQ+IHtcblx0XHRyZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUpID0+IHtcblx0XHRcdGNvbnN0IG9uQ2hhbmdlID0gKGNoYW5nZWRGaWxlOiBURmlsZSkgPT4ge1xuXHRcdFx0XHRpZiAoY2hhbmdlZEZpbGUucGF0aCA9PT0gZmlsZS5wYXRoKSB7XG5cdFx0XHRcdFx0dGhpcy5hcHAubWV0YWRhdGFDYWNoZS5vZmYoJ2NoYW5nZWQnLCBvbkNoYW5nZSk7XG5cdFx0XHRcdFx0cmVzb2x2ZSgpO1xuXHRcdFx0XHR9XG5cdFx0XHR9O1xuXG5cdFx0XHR0aGlzLmFwcC5tZXRhZGF0YUNhY2hlLm9uKCdjaGFuZ2VkJywgb25DaGFuZ2UpO1xuXHRcdH0pO1xuXHR9XG5cblx0cHJpdmF0ZSBhc3luYyB3YWl0Rm9yTWV0YWRhdGFSZWFkeShcblx0XHRmaWxlOiBURmlsZSxcblx0XHR0aW1lb3V0ID0gNTAwMCxcblx0KTogUHJvbWlzZTx2b2lkPiB7XG5cdFx0Y29uc3Qgc3RhcnQgPSBEYXRlLm5vdygpO1xuXG5cdFx0Ly8gVXNlIHJlY3Vyc2lvbiB0byBhdm9pZCAnYXdhaXQgaW4gbG9vcCdcblx0XHRjb25zdCBjaGVjayA9IGFzeW5jICgpOiBQcm9taXNlPHZvaWQ+ID0+IHtcblx0XHRcdGNvbnN0IGZpbGVDYWNoZSA9IHRoaXMuYXBwLm1ldGFkYXRhQ2FjaGUuZ2V0RmlsZUNhY2hlKGZpbGUpO1xuXHRcdFx0Y29uc3QgYmFja2xpbmtzID0gdGhpcy5hcHAubWV0YWRhdGFDYWNoZS5yZXNvbHZlZExpbmtzW2ZpbGUucGF0aF07XG5cblx0XHRcdGlmIChmaWxlQ2FjaGUgJiYgYmFja2xpbmtzKSB7XG5cdFx0XHRcdHJldHVybjtcblx0XHRcdH1cblxuXHRcdFx0aWYgKERhdGUubm93KCkgLSBzdGFydCA+IHRpbWVvdXQpIHtcblx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0fVxuXG5cdFx0XHQvLyBXYWl0IGVpdGhlciBmb3IgZGVsYXkgb3IgbWV0YWRhdGEgY2hhbmdlIGV2ZW50LCB3aGljaGV2ZXIgY29tZXMgZmlyc3Rcblx0XHRcdGF3YWl0IFByb21pc2UucmFjZShbXG5cdFx0XHRcdHRoaXMuZGVsYXkoMTAwKSxcblx0XHRcdFx0dGhpcy53YWl0Rm9yTWV0YWRhdGFDaGFuZ2UoZmlsZSksXG5cdFx0XHRdKTtcblxuXHRcdFx0cmV0dXJuIGNoZWNrKCk7XG5cdFx0fTtcblxuXHRcdGF3YWl0IGNoZWNrKCk7XG5cdH1cblxuXHRwcml2YXRlIGdldFZhdWx0QmFzZVBhdGgoKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcblx0XHRjb25zdCBhZGFwdGVyID0gdGhpcy5hcHAudmF1bHQuYWRhcHRlcjtcblx0XHRpZiAoYWRhcHRlciBpbnN0YW5jZW9mIEZpbGVTeXN0ZW1BZGFwdGVyKSB7XG5cdFx0XHRyZXR1cm4gYWRhcHRlci5nZXRCYXNlUGF0aCgpOyAvLyBhYnNvbHV0ZSBwYXRoIHRvIHZhdWx0XG5cdFx0fVxuXG5cdFx0cmV0dXJuIHVuZGVmaW5lZDtcblx0fVxuXG5cdC8qIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0gLSAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLSAqL1xuXG5cdHByaXZhdGUgYXN5bmMgcHJvY2Vzc0ZpbGUoZmlsZTogVEZpbGUpOiBQcm9taXNlPHZvaWQ+IHtcblx0XHRuZXcgTm90aWNlKGBJbWFnZSBPcHRpbWl6ZXI6IFdhaXRpbmcgZm9yIG1ldGFkYXRhIGNhY2hlLi4uYCk7XG5cdFx0Ly8gYXdhaXQgZnJlc2ggbWV0YWRhdGEgYmVmb3JlIHN0YXJ0aW5nIGFueXRoaW5nXG5cdFx0YXdhaXQgdGhpcy53YWl0Rm9yTWV0YWRhdGFSZWFkeShmaWxlKTtcblxuXHRcdGNvbnN0IG9sZE5hbWUgPSBmaWxlLm5hbWU7XG5cblx0XHQvLyBTa2lwIGlmIGZpbGVuYW1lIGFscmVhZHkgZW5kcyB3aXRoIGEgc2x1Zy1oYXNoIHBhdHRlcm5cblx0XHRjb25zdCBleHRlbnNpb24gPSBmaWxlLmV4dGVuc2lvbi50b0xvd2VyQ2FzZSgpO1xuXHRcdGNvbnN0IGJhc2VuYW1lID0gZmlsZS5iYXNlbmFtZTtcblx0XHRjb25zdCBmdWxsTmFtZSA9IGAke2Jhc2VuYW1lfS4ke2V4dGVuc2lvbn1gO1xuXHRcdGlmICgvLVthLWZcXGRdezh9XFwuW2Etel17Miw0fSQvaS50ZXN0KGZ1bGxOYW1lKSkge1xuXHRcdFx0bmV3IE5vdGljZShcblx0XHRcdFx0YEltYWdlIE9wdGltaXplcjogU2tpcHBpbmcgXCIke2Z1bGxOYW1lfVwiOiBhbHJlYWR5IGhhc2hlZGAsXG5cdFx0XHQpO1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblxuXHRcdC8qIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0gY29tcHJlc3MgLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0gKi9cblxuXHRcdGlmICghdGhpcy5zZXR0aW5ncy5ydW50aW1lQWJzb2x1dGVQYXRoKSB7XG5cdFx0XHRuZXcgTm90aWNlKFxuXHRcdFx0XHQnSW1hZ2UgT3B0aW1pemVyOiBNaXNzaW5nIHJ1bnRpbWUgYWJzb2x1dGUgcGF0aC4gU2VlIHNldHRpbmdzLicsXG5cdFx0XHQpO1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblxuXHRcdGlmICghdGhpcy5zZXR0aW5ncy5jb21wcmVzc2lvblNjcmlwdEFic29sdXRlUGF0aCkge1xuXHRcdFx0bmV3IE5vdGljZShcblx0XHRcdFx0J0ltYWdlIE9wdGltaXplcjogTWlzc2luZyBjb21wcmVzc2lvbiBzY3JpcHQgYWJzb2x1dGUgcGF0aC4gU2VlIHNldHRpbmdzLicsXG5cdFx0XHQpO1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblxuXHRcdC8vIEdldCBhYnNvbHV0ZSBmaWxlIHBhdGhcblx0XHRjb25zdCBiYXNlUGF0aCA9IHRoaXMuZ2V0VmF1bHRCYXNlUGF0aCgpO1xuXHRcdGlmICghYmFzZVBhdGgpIHRocm93IG5ldyBFcnJvcignU2hvdWxkIG5ldmVyIHJlYWNoIGhlcmUnKTtcblx0XHRjb25zdCBhYnNvbHV0ZUZpbGVQYXRoID0gcGF0aC5qb2luKGJhc2VQYXRoLCBmaWxlLnBhdGgpO1xuXG5cdFx0Ly8gcnVuIGV4dGVybmFsIGNvbXByZXNzaW9uIHNjcmlwdFxuXHRcdC8vIHNpbmNlIGBzaGFycGAgY2Fubm90IHJ1biBpbiBPYnNpZGlhbiBuYXRpdmUgYmluZGluZ3MsIG9yIHNvbWV0aGluZ1xuXHRcdHRyeSB7XG5cdFx0XHQvLyBUT0RPOiBhbGxvdyBjdXN0b20gY29tcHJlc3Npb24gYXJnc1xuXHRcdFx0YXdhaXQgZXhlY0ZpbGVBc3luYyh0aGlzLnNldHRpbmdzLnJ1bnRpbWVBYnNvbHV0ZVBhdGgsIFtcblx0XHRcdFx0dGhpcy5zZXR0aW5ncy5jb21wcmVzc2lvblNjcmlwdEFic29sdXRlUGF0aCxcblx0XHRcdFx0YWJzb2x1dGVGaWxlUGF0aCxcblx0XHRcdF0pO1xuXHRcdH0gY2F0Y2ggKGVycm9yKSB7XG5cdFx0XHRjb25zb2xlLmVycm9yKCdFcnJvciBkdXJpbmcgY29tcHJlc3Npb246JywgZXJyb3IpO1xuXHRcdFx0bmV3IE5vdGljZSgnSW1hZ2UgT3B0aW1pemVyOiBJbWFnZSBjb21wcmVzc2lvbiBmYWlsZWQuJyk7XG5cdFx0fVxuXG5cdFx0Ly8gRmluZCBuZXcgY29tcHJlc3NlZCBmaWxlXG5cdFx0Y29uc3QgY29tcHJlc3NlZFJlbGF0aXZlUGF0aCA9IG5vcm1hbGl6ZVBhdGgoXG5cdFx0XHRgJHtmaWxlLnBhdGguc2xpY2UoMCwgLWV4dGVuc2lvbi5sZW5ndGggLSAxKX0udGVtcGAsXG5cdFx0KTtcblx0XHRjb25zdCBjb21wcmVzc2VkRmlsZSA9IHRoaXMuYXBwLnZhdWx0LmdldEFic3RyYWN0RmlsZUJ5UGF0aChcblx0XHRcdGNvbXByZXNzZWRSZWxhdGl2ZVBhdGgsXG5cdFx0KTtcblx0XHRpZiAoIShjb21wcmVzc2VkRmlsZSBpbnN0YW5jZW9mIFRGaWxlKSB8fCAhY29tcHJlc3NlZEZpbGUpIHtcblx0XHRcdG5ldyBOb3RpY2UoJ0ltYWdlIE9wdGltaXplcjogQ29tcHJlc3NlZCBmaWxlIG5vdCBmb3VuZCBpbiB2YXVsdC4nKTtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cblx0XHQvKiAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0gaGFzaCAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tICovXG5cdFx0Y29uc3QgYXJyYXlCdWZmZXIgPSBhd2FpdCB0aGlzLmFwcC52YXVsdC5yZWFkQmluYXJ5KGNvbXByZXNzZWRGaWxlKTtcblx0XHRjb25zdCBoYXNoID0gY3JlYXRlSGFzaCgnbWQ1Jylcblx0XHRcdC51cGRhdGUoQnVmZmVyLmZyb20oYXJyYXlCdWZmZXIpKVxuXHRcdFx0LmRpZ2VzdCgnaGV4Jylcblx0XHRcdC5zbGljZSgwLCA4KTtcblxuXHRcdC8qIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLSBzbHVnIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0gKi9cblx0XHRjb25zdCBzbHVnID0gc2x1Z2lmeShiYXNlbmFtZSk7XG5cdFx0Ly8gY29uc3QgbmV3TmFtZSA9IGAke3NsdWd9LSR7aGFzaH0uJHtleHRlbnNpb259YDtcblx0XHRjb25zdCBuZXdOYW1lID0gYCR7c2x1Z30tJHtoYXNofS53ZWJwYDtcblxuXHRcdC8vIGdldCBuZXcgcm91dGVcblx0XHRjb25zdCBwYXJlbnRQYXRoID0gKCgpID0+IHtcblx0XHRcdGlmIChmaWxlLnBhcmVudD8ucGF0aCA9PT0gJy8nKSB7XG5cdFx0XHRcdHJldHVybiAnLic7XG5cdFx0XHR9XG5cblx0XHRcdHJldHVybiBmaWxlLnBhcmVudD8ucGF0aCA/PyAnJztcblx0XHR9KSgpO1xuXHRcdGNvbnN0IG5ld1BhdGggPSBwYXRoLmpvaW4ocGFyZW50UGF0aCwgbmV3TmFtZSk7XG5cblx0XHQvKiAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0gd3JpdGUgLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tICovXG5cblx0XHQvLyBTa2lwIGlmIGEgZmlsZSB3aXRoIHRoZSBzYW1lIG5hbWUgYWxyZWFkeSBleGlzdHNcblx0XHRjb25zdCBtYXliZUV4aXN0aW5nID0gdGhpcy5hcHAudmF1bHQuZ2V0QWJzdHJhY3RGaWxlQnlQYXRoKG5ld1BhdGgpO1xuXHRcdGlmIChtYXliZUV4aXN0aW5nKSB7XG5cdFx0XHRuZXcgTm90aWNlKFxuXHRcdFx0XHRgSW1hZ2UgT3B0aW1pemVyOiBTa2lwcGVkIC0gXCIke25ld05hbWV9XCIgYWxyZWFkeSBlbmRzIGluIGFuIDgtY2hhcmFjdGVyIGhhc2guIFJlbW92ZSB0aGF0IHN1ZmZpeCBhbmQgdHJ5IGFnYWluP2AsXG5cdFx0XHQpO1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblxuXHRcdC8vIHJlcGxhY2UgZmlsZVxuXHRcdGF3YWl0IHRoaXMuYXBwLmZpbGVNYW5hZ2VyLnJlbmFtZUZpbGUoZmlsZSwgbmV3UGF0aCk7XG5cdFx0YXdhaXQgdGhpcy5hcHAudmF1bHQuZGVsZXRlKGZpbGUpO1xuXHRcdGF3YWl0IHRoaXMuYXBwLmZpbGVNYW5hZ2VyLnJlbmFtZUZpbGUoY29tcHJlc3NlZEZpbGUsIG5ld1BhdGgpO1xuXG5cdFx0Ly8gR2V0IHRoZSBuZXdseSBjcmVhdGVkIGZpbGUgYXMgYSBURmlsZVxuXHRcdGNvbnN0IG5ld0ZpbGUgPSB0aGlzLmFwcC52YXVsdC5nZXRBYnN0cmFjdEZpbGVCeVBhdGgobmV3UGF0aCk7XG5cdFx0aWYgKCEobmV3RmlsZSBpbnN0YW5jZW9mIFRGaWxlKSkge1xuXHRcdFx0Ly8gc2hvdWxkIG5vdCByZWFjaCBoZXJlXG5cdFx0XHRuZXcgTm90aWNlKFxuXHRcdFx0XHRgSW1hZ2UgT3B0aW1pemVyOiBGYWlsZWQgdG8gZmluZCBuZXcgZmlsZSAtIFwiJHtuZXdOYW1lfVwiYCxcblx0XHRcdCk7XG5cdFx0XHRyZXR1cm47XG5cdFx0fVxuXG5cdFx0bmV3IE5vdGljZShgSW1hZ2UgT3B0aW1pemVyOiBSZW5hbWVkICR7b2xkTmFtZX0g4oaSICR7bmV3TmFtZX1gLCAzMDAwKTtcblx0fVxufVxuXG5jbGFzcyBTYW1wbGVTZXR0aW5nVGFiIGV4dGVuZHMgUGx1Z2luU2V0dGluZ1RhYiB7XG5cdGNvbnN0cnVjdG9yKHByaXZhdGUgcmVhZG9ubHkgcGx1Z2luOiBNeVBsdWdpbikge1xuXHRcdHN1cGVyKHBsdWdpbi5hcHAsIHBsdWdpbik7XG5cdH1cblxuXHRkaXNwbGF5KCk6IHZvaWQge1xuXHRcdGNvbnN0IHtjb250YWluZXJFbH0gPSB0aGlzO1xuXHRcdGNvbnRhaW5lckVsLmVtcHR5KCk7XG5cblx0XHRjb250YWluZXJFbC5jcmVhdGVFbCgnaDInLCB7dGV4dDogJ0ltYWdlIFBsdWdpbiBTZXR0aW5ncyd9KTtcblxuXHRcdG5ldyBTZXR0aW5nKGNvbnRhaW5lckVsKVxuXHRcdFx0LnNldE5hbWUoJ1RyaWdnZXIgYXV0b21hdGljYWxseScpXG5cdFx0XHQuc2V0RGVzYyhcblx0XHRcdFx0J0F1dG9tYXRpY2FsbHkgcHJvY2VzcyBuZXcgaW1hZ2UgZmlsZXMgYWRkZWQgdG8gdGhlIHZhdWx0LicsXG5cdFx0XHQpXG5cdFx0XHQuYWRkVG9nZ2xlKCh0b2dnbGUpID0+XG5cdFx0XHRcdHRvZ2dsZVxuXHRcdFx0XHRcdC5zZXRWYWx1ZSh0aGlzLnBsdWdpbi5zZXR0aW5ncy5pc1RyaWdnZXJPbkNyZWF0ZSlcblx0XHRcdFx0XHQub25DaGFuZ2UoYXN5bmMgKHZhbHVlKSA9PiB7XG5cdFx0XHRcdFx0XHR0aGlzLnBsdWdpbi5zZXR0aW5ncy5pc1RyaWdnZXJPbkNyZWF0ZSA9IHZhbHVlO1xuXHRcdFx0XHRcdFx0YXdhaXQgdGhpcy5wbHVnaW4uc2F2ZVNldHRpbmdzKCk7XG5cdFx0XHRcdFx0XHR0aGlzLnBsdWdpbi5hcHBseVNldHRpbmdzKCk7XG5cdFx0XHRcdFx0fSksXG5cdFx0XHQpO1xuXG5cdFx0bmV3IFNldHRpbmcoY29udGFpbmVyRWwpXG5cdFx0XHQuc2V0TmFtZSgnQWJzb2x1dGUgcGF0aCB0byBydW50aW1lJylcblx0XHRcdC5hZGRUZXh0KCh0ZXh0KSA9PlxuXHRcdFx0XHR0ZXh0XG5cdFx0XHRcdFx0LnNldFBsYWNlaG9sZGVyKCdFbnRlciB2YWx1ZScpXG5cdFx0XHRcdFx0LnNldFZhbHVlKHRoaXMucGx1Z2luLnNldHRpbmdzLnJ1bnRpbWVBYnNvbHV0ZVBhdGgpXG5cdFx0XHRcdFx0Lm9uQ2hhbmdlKGFzeW5jICh2YWx1ZSkgPT4ge1xuXHRcdFx0XHRcdFx0dGhpcy5wbHVnaW4uc2V0dGluZ3MucnVudGltZUFic29sdXRlUGF0aCA9IHZhbHVlO1xuXHRcdFx0XHRcdFx0YXdhaXQgdGhpcy5wbHVnaW4uc2F2ZVNldHRpbmdzKCk7XG5cdFx0XHRcdFx0fSksXG5cdFx0XHQpO1xuXG5cdFx0bmV3IFNldHRpbmcoY29udGFpbmVyRWwpXG5cdFx0XHQuc2V0TmFtZSgnQWJzb2x1dGUgcGF0aCB0byBjb21wcmVzc2lvbiBzY3JpcHQnKVxuXHRcdFx0LmFkZFRleHRBcmVhKCh0ZXh0KSA9PlxuXHRcdFx0XHR0ZXh0XG5cdFx0XHRcdFx0LnNldFBsYWNlaG9sZGVyKCdFbnRlciB2YWx1ZScpXG5cdFx0XHRcdFx0LnNldFZhbHVlKFxuXHRcdFx0XHRcdFx0dGhpcy5wbHVnaW4uc2V0dGluZ3MuY29tcHJlc3Npb25TY3JpcHRBYnNvbHV0ZVBhdGgsXG5cdFx0XHRcdFx0KVxuXHRcdFx0XHRcdC5vbkNoYW5nZShhc3luYyAodmFsdWUpID0+IHtcblx0XHRcdFx0XHRcdHRoaXMucGx1Z2luLnNldHRpbmdzLmNvbXByZXNzaW9uU2NyaXB0QWJzb2x1dGVQYXRoID1cblx0XHRcdFx0XHRcdFx0dmFsdWU7XG5cdFx0XHRcdFx0XHRhd2FpdCB0aGlzLnBsdWdpbi5zYXZlU2V0dGluZ3MoKTtcblx0XHRcdFx0XHR9KSxcblx0XHRcdCk7XG5cdH1cbn1cblxuY2xhc3MgSW1hZ2VDcmVhdGVIYW5kbGVyIHtcblx0cHJpdmF0ZSBldmVudFJlZjogRXZlbnRSZWYgfCB1bmRlZmluZWQgPSB1bmRlZmluZWQ7XG5cblx0Y29uc3RydWN0b3IoXG5cdFx0cHJpdmF0ZSByZWFkb25seSBhcHA6IEFwcCxcblx0XHRwcml2YXRlIHJlYWRvbmx5IHByb2Nlc3NGaWxlOiAoZmlsZTogVEZpbGUpID0+IFByb21pc2U8dm9pZD4sXG5cdCkge31cblxuXHRlbmFibGUoKSB7XG5cdFx0aWYgKHRoaXMuZXZlbnRSZWYpIHJldHVybjtcblxuXHRcdHRoaXMuZXZlbnRSZWYgPSB0aGlzLmFwcC52YXVsdC5vbignY3JlYXRlJywgKGZpbGUpID0+IHtcblx0XHRcdGlmICghKGZpbGUgaW5zdGFuY2VvZiBURmlsZSkpIHJldHVybjtcblx0XHRcdGlmICghaXNJbWFnZShmaWxlKSkgcmV0dXJuO1xuXHRcdFx0Ly8gVE9ETzogYmV0dGVyIGRldGVjdGlvbiBmb3Igb3B0aW1pemVkIGltYWdlcz9cblx0XHRcdGlmIChmaWxlLmV4dGVuc2lvbiA9PT0gJ3RlbXAnKSByZXR1cm47XG5cblx0XHRcdHZvaWQgdGhpcy5wcm9jZXNzRmlsZShmaWxlKTtcblx0XHR9KTtcblx0fVxuXG5cdGRpc2FibGUoKSB7XG5cdFx0aWYgKHRoaXMuZXZlbnRSZWYpIHtcblx0XHRcdHRoaXMuYXBwLnZhdWx0Lm9mZnJlZih0aGlzLmV2ZW50UmVmKTtcblx0XHRcdHRoaXMuZXZlbnRSZWYgPSB1bmRlZmluZWQ7XG5cdFx0fVxuXHR9XG59XG4iXSwibmFtZXMiOlsicHJvbWlzaWZ5IiwiZXhlY0ZpbGUiLCJQbHVnaW4iLCJOb3RpY2UiLCJGaWxlU3lzdGVtQWRhcHRlciIsIm5vcm1hbGl6ZVBhdGgiLCJURmlsZSIsImNyZWF0ZUhhc2giLCJQbHVnaW5TZXR0aW5nVGFiIiwiU2V0dGluZyJdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7QUF1QkEsTUFBTSxnQkFBZ0IsR0FBbUI7QUFDeEMsSUFBQSxtQkFBbUIsRUFBRSxFQUFFO0FBQ3ZCLElBQUEsNkJBQTZCLEVBQUUsRUFBRTtBQUNqQyxJQUFBLGlCQUFpQixFQUFFLElBQUk7Q0FDdkI7QUFFRCxNQUFNLGFBQWEsR0FBR0EsbUJBQVMsQ0FBQ0MsMkJBQVEsQ0FBQztBQUV6QyxTQUFTLE9BQU8sQ0FBQyxJQUFXLEVBQUE7SUFDM0IsT0FBTyxzQkFBc0IsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQztBQUM5QztBQUVBLFNBQVMsT0FBTyxDQUFDLElBQVksRUFBQTtBQUM1QixJQUFBLE9BQU87QUFDTCxTQUFBLFdBQVc7QUFDWCxTQUFBLFVBQVUsQ0FBQyxZQUFZLEVBQUUsR0FBRztBQUM1QixTQUFBLFVBQVUsQ0FBQyxVQUFVLEVBQUUsRUFBRSxDQUFDO0FBQzdCO0FBRXFCLE1BQUEsUUFBUyxTQUFRQyxlQUFNLENBQUE7QUFJM0MsSUFBQSxNQUFNLE1BQU0sR0FBQTs7UUFFWCxJQUFJLENBQUMsVUFBVSxDQUFDO0FBQ2YsWUFBQSxFQUFFLEVBQUUscUJBQXFCO0FBQ3pCLFlBQUEsSUFBSSxFQUFFLDRCQUE0QjtZQUNsQyxRQUFRLEVBQUUsWUFBVztnQkFDcEIsTUFBTSxJQUFJLEdBQUcsSUFBSSxDQUFDLEdBQUcsQ0FBQyxTQUFTLENBQUMsYUFBYSxFQUFFO2dCQUUvQyxJQUFJLENBQUMsSUFBSSxFQUFFO0FBQ1Ysb0JBQUEsSUFBSUMsZUFBTSxDQUFDLGlDQUFpQyxDQUFDO29CQUM3Qzs7QUFHRCxnQkFBQSxJQUFJLENBQUMsT0FBTyxDQUFDLElBQUksQ0FBQyxFQUFFO0FBQ25CLG9CQUFBLElBQUlBLGVBQU0sQ0FBQyw4Q0FBOEMsQ0FBQztvQkFDMUQ7O0FBR0QsZ0JBQUEsTUFBTSxJQUFJLENBQUMsV0FB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
