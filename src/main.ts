import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {promisify} from 'node:util';
import {
	type App,
	type EventRef,
	FileSystemAdapter,
	Modal,
	normalizePath,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
} from 'obsidian';

type PluginSettings = {
	runtimeAbsolutePath: string;
	compressionScriptAbsolutePath: string;
	isTriggerOnCreate: boolean;
};

const DEFAULT_SETTINGS: PluginSettings = {
	runtimeAbsolutePath: '',
	compressionScriptAbsolutePath: '',
	isTriggerOnCreate: true,
};

const execFileAsync = promisify(execFile);

function isImage(file: TFile): boolean {
	return /\.(png|jpe?g|webp)$/i.test(file.path);
}

function slugify(name: string): string {
	return name
		.toLowerCase()
		.replaceAll(/[^a-z\d]+/g, '-')
		.replaceAll(/^-+|-+$/g, '');
}

export default class MyPlugin extends Plugin {
	settings: PluginSettings;
	imageHandler: ImageCreateHandler;

	async onload() {
		// Manual command from Command Palette
		this.addCommand({
			id: 'rename-active-image',
			name: 'Optimize active image file',
			callback: async () => {
				const file = this.app.workspace.getActiveFile();

				if (!file) {
					new Notice('Image Optimizer: No active file');
					return;
				}

				if (!isImage(file)) {
					new Notice('Image Optimizer: Active file is not an image');
					return;
				}

				await this.processFile(file);
			},
		});
		// This adds a settings tab so the user can configure various aspects of the plugin
		await this.loadSettings();
		this.imageHandler = new ImageCreateHandler(
			this.app,
			this.processFile.bind(this) as typeof this.processFile,
		);
		this.app.workspace.onLayoutReady(() => {
			this.applySettings();
		});
		this.addSettingTab(new SampleSettingTab(this));
	}

	async loadSettings() {
		const loaded = (await this.loadData()) as Partial<PluginSettings>;
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
		} else {
			this.imageHandler.disable();
		}
	}

	async updateSettings(newSettings: Partial<PluginSettings>) {
		Object.assign(this.settings, newSettings);
		await this.saveSettings();
		this.applySettings();
	}

	onunload() {
		this.imageHandler.disable();
	}

	/* -------------------- only run after metadata ready --------------------- */
	// file renaming will be partial if metadata cache has not refreshed

	private async delay(ms: number): Promise<void> {
		return new Promise((resolve) => {
			setTimeout(resolve, ms);
		});
	}

	private async waitForMetadataChange(file: TFile): Promise<void> {
		return new Promise((resolve) => {
			const onChange = (changedFile: TFile) => {
				if (changedFile.path === file.path) {
					this.app.metadataCache.off('changed', onChange);
					resolve();
				}
			};

			this.app.metadataCache.on('changed', onChange);
		});
	}

	private async waitForMetadataReady(
		file: TFile,
		timeout = 5000,
	): Promise<void> {
		const start = Date.now();

		// Use recursion to avoid 'await in loop'
		const check = async (): Promise<void> => {
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

	private getVaultBasePath(): string | undefined {
		const adapter = this.app.vault.adapter;
		if (adapter instanceof FileSystemAdapter) {
			return adapter.getBasePath(); // absolute path to vault
		}

		return undefined;
	}

	/* ------------------------------- - ----------------------------------- */

	private async processFile(file: TFile): Promise<void> {
		const oldName = file.name;

		// Skip if filename already ends with a slug-hash pattern
		const extension = file.extension.toLowerCase();
		const basename = file.basename;
		const fullName = `${basename}.${extension}`;
		if (/-[a-f\d]{8}\.[a-z]{2,4}$/i.test(fullName)) {
			new Notice(`Image Optimizer: Skipping ${fullName}, already hashed`);
			return;
		}

		/* ---------------------------- compress -------------------------------- */

		if (!this.settings.runtimeAbsolutePath) {
			new Notice(
				'Image Optimizer: Missing runtime absolute path. See settings.',
			);
			return;
		}

		if (!this.settings.compressionScriptAbsolutePath) {
			new Notice(
				'Image Optimizer: Missing compression script absolute path. See settings.',
			);
			return;
		}

		// Get absolute file path
		const basePath = this.getVaultBasePath();
		if (!basePath) throw new Error('Should never reach here');
		const absoluteFilePath = path.join(basePath, file.path);

		// run external compression script
		// since `sharp` cannot run in Obsidian native bindings, or something
		try {
			// TODO: allow custom compression args
			await execFileAsync(this.settings.runtimeAbsolutePath, [
				this.settings.compressionScriptAbsolutePath,
				absoluteFilePath,
			]);
		} catch (error) {
			console.error('Error during compression:', error);
			new Notice('Image Optimizer: Image compression failed.');
		}

		// Find new compressed file
		const compressedRelativePath = normalizePath(
			`${file.path.slice(0, -extension.length - 1)}.temp`,
		);
		const compressedFile = this.app.vault.getAbstractFileByPath(
			compressedRelativePath,
		);
		if (!(compressedFile instanceof TFile) || !compressedFile) {
			new Notice('Image Optimizer: Compressed file not found in vault.');
			return;
		}

		/* ------------------------------ hash ---------------------------------- */
		const arrayBuffer = await this.app.vault.readBinary(compressedFile);
		const hash = createHash('md5')
			.update(Buffer.from(arrayBuffer))
			.digest('hex')
			.slice(0, 8);

		/* ------------------------------ slug ---------------------------------- */
		const slug = slugify(basename);
		// TODO: settings template for new file extension
		const newName = `${slug}-${hash}.webp`;

		// get new route
		const parentPath = (() => {
			if (file.parent?.path === '/') {
				return '.';
			}

			return file.parent?.path ?? '';
		})();
		const newPath = path.join(parentPath, newName);

		new Notice(`Image Optimizer: Waiting for metadata cache...`);
		// await fresh metadata before starting anything
		await this.waitForMetadataReady(file);

		/* ------------------------------ write --------------------------------- */

		// Skip if a file with the same name already exists
		const maybeExisting = this.app.vault.getAbstractFileByPath(newPath);
		if (maybeExisting) {
			new Notice(
				`Image Optimizer: Skipped ${newName}, as it already ends in an 8-character hash. Remove that suffix and try again?`,
			);
			return;
		}

		// replace file
		await this.app.fileManager.renameFile(file, newPath);
		await this.app.vault.delete(file);
		await this.app.fileManager.renameFile(compressedFile, newPath);

		// Get the newly created file as a TFile
		const newFile = this.app.vault.getAbstractFileByPath(newPath);
		if (!(newFile instanceof TFile)) {
			// should not reach here
			new Notice(`Image Optimizer: Failed to find new file ${newName}`);
			return;
		}

		new Notice(`Image Optimizer: Renamed ${oldName} → ${newName}`, 3000);
	}
}

class SampleSettingTab extends PluginSettingTab {
	constructor(private readonly plugin: MyPlugin) {
		super(plugin.app, plugin);
	}

	display(): void {
		const {containerEl} = this;
		containerEl.empty();

		containerEl.createEl('h2', {text: 'Image Plugin Settings'});

		new Setting(containerEl)
			.setName('Trigger automatically')
			.setDesc(
				'Automatically process new image files added to the vault.',
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.isTriggerOnCreate)
					.onChange(async (value) => {
						this.plugin.settings.isTriggerOnCreate = value;
						await this.plugin.saveSettings();
						this.plugin.applySettings();
					}),
			);

		new Setting(containerEl)
			.setName('Absolute path to runtime')
			.addText((text) =>
				text
					.setPlaceholder('Enter value')
					.setValue(this.plugin.settings.runtimeAbsolutePath)
					.onChange(async (value) => {
						this.plugin.settings.runtimeAbsolutePath = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Absolute path to compression script')
			.addTextArea((text) =>
				text
					.setPlaceholder('Enter value')
					.setValue(
						this.plugin.settings.compressionScriptAbsolutePath,
					)
					.onChange(async (value) => {
						this.plugin.settings.compressionScriptAbsolutePath =
							value;
						await this.plugin.saveSettings();
					}),
			);
	}
}

class ImageCreateHandler {
	private eventRef: EventRef | undefined = undefined;

	constructor(
		private readonly app: App,
		private readonly processFile: (file: TFile) => Promise<void>,
	) {}

	enable() {
		if (this.eventRef) return;

		this.eventRef = this.app.vault.on('create', (file) => {
			if (!(file instanceof TFile)) return;
			if (!isImage(file)) return;
			// TODO: better detection for optimized images?
			if (file.extension === 'temp') return;

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
