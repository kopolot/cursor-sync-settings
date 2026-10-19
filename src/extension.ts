import path from 'path';
import fse from 'fs-extra';
import vscode from 'vscode';
import pkg from '../package.json';
import { createProfile } from './commands/create-profile.js';
import { deleteProfile } from './commands/delete-profile.js';
import { download } from './commands/download.js';
import { listMissingExtensions } from './commands/list-missing-extensions.js';
import { openProfileDirectory } from './commands/open-profile-directory.js';
import { openProfileSettings } from './commands/open-profile-settings.js';
import { openRepositoryDirectory } from './commands/open-repository-directory.js';
import { openSettings } from './commands/open-settings.js';
import { reset } from './commands/reset.js';
import { restart } from './commands/restart.js';
import { review } from './commands/review.js';
import { switchProfile } from './commands/switch-profile.js';
import { upload } from './commands/upload.js';
import { viewDifferences } from './commands/view-differences.js';
import { setupCrons } from './crons.js';
import { RepositoryFactory } from './repository-factory.js';
import { Settings } from './settings.js';
import { ThrottledDelayer } from './utils/async.js';
import { EXTENSION_NAME } from './utils/constants.js';
import { detectEditor } from './utils/editor.js';
import { Logger } from './utils/logger.js';
import { readStateDB } from './utils/read-statedb.js';
import { setupSettings } from './utils/settings.js';

const VERSION_KEY = 'version';

async function showWhatsNewMessage(version: string) { // {{{
	const releaseNotes: vscode.MessageItem = {
		title: 'Release Notes',
	};

	const result = await vscode.window.showInformationMessage(
		`${EXTENSION_NAME} has been updated to v${version} — check out what's new!`,
		releaseNotes,
	);

	if(result === releaseNotes) {
		const extension = vscode.extensions.getExtension('kopolot.cursor-sync-settings');

		if(extension) {
			await vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.joinPath(extension.extensionUri, 'CHANGELOG.md'));
		}
	}
} // }}}

async function oldSyncExtensionEnabled(context: vscode.ExtensionContext): Promise<boolean> {
	if(!vscode.extensions.getExtension('zokugun.sync-settings')) {
		return false;
	}

	try {
		const databasePath = path.join(context.globalStorageUri.fsPath, '..', 'state.vscdb');
		const data = await readStateDB(databasePath, 'SELECT value FROM ItemTable WHERE key = \'extensionsIdentifiers/disabled\'');
		const raw = data?.values?.[0]?.[0];
		const parsed: unknown = typeof raw === 'string' ? JSON.parse(raw) : [];
		const disabled = Array.isArray(parsed) && parsed.some(item => typeof item === 'object' && item !== null && 'id' in item && item.id === 'zokugun.sync-settings');

		return !disabled;
	}
	catch {
		return true;
	}
}

async function reusePreviousRepository(context: vscode.ExtensionContext): Promise<void> {
	const storage = context.globalStorageUri.fsPath;
	const settingsPath = path.join(storage, 'settings.yml');
	const repository = path.join(storage, 'repository');
	const previous = path.join(storage, '..', 'zokugun.sync-settings');
	const previousSettings = path.join(previous, 'settings.yml');
	const previousRepository = path.join(previous, 'repository');
	const hasSettings = await fse.pathExists(settingsPath);
	const hasRepository = await fse.pathExists(repository);

	if(hasSettings && hasRepository) {
		return;
	}

	if(!hasSettings && await fse.pathExists(previousSettings)) {
		await fse.ensureDir(storage);
		await fse.copy(previousSettings, settingsPath);
	}

	if(!hasRepository && await fse.pathExists(previousRepository)) {
		await fse.ensureDir(storage);
		await fse.copy(previousRepository, repository);
	}
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	await reusePreviousRepository(context);
	await setupSettings(context);

	Logger.setup(false);

	if(await oldSyncExtensionEnabled(context)) {
		void vscode.window.showWarningMessage('Disable zokugun.sync-settings. Cursor Sync Settings replaces it, and having both enabled turns the agent host off.');
	}

	detectEditor(context);

	context.globalState.setKeysForSync([VERSION_KEY]);

	const previousVersion = context.globalState.get<string>(VERSION_KEY);
	const currentVersion = pkg.version;

	const config = vscode.workspace.getConfiguration('syncSettings');

	if(previousVersion === undefined || currentVersion !== previousVersion) {
		void context.globalState.update(VERSION_KEY, currentVersion);

		const notification = config.get<string>('notification');

		if(previousVersion === undefined) {
			// don't show notification on install
		}
		else if(notification === 'major') {
			if(currentVersion.split('.')[0] > previousVersion.split('.')[0]) {
				void showWhatsNewMessage(currentVersion);
			}
		}
		else if(notification === 'minor') {
			if(currentVersion.split('.')[0] > previousVersion.split('.')[0] || (currentVersion.split('.')[0] === previousVersion.split('.')[0] && currentVersion.split('.')[1] > previousVersion.split('.')[1])) {
				void showWhatsNewMessage(currentVersion);
			}
		}
		else if(notification !== 'none') {
			void showWhatsNewMessage(currentVersion);
		}
	}

	await Settings.load(context);

	const disposables: vscode.Disposable[] = [];

	disposables.push(
		vscode.commands.registerCommand('syncSettings.createProfile', createProfile),
		vscode.commands.registerCommand('syncSettings.deleteProfile', deleteProfile),
		vscode.commands.registerCommand('syncSettings.download', download),
		vscode.commands.registerCommand('syncSettings.listMissingExtensions', listMissingExtensions),
		vscode.commands.registerCommand('syncSettings.openProfileDirectory', openProfileDirectory),
		vscode.commands.registerCommand('syncSettings.openProfileSettings', openProfileSettings),
		vscode.commands.registerCommand('syncSettings.openRepositoryDirectory', openRepositoryDirectory),
		vscode.commands.registerCommand('syncSettings.openSettings', openSettings),
		vscode.commands.registerCommand('syncSettings.reset', reset),
		vscode.commands.registerCommand('syncSettings.restart', restart),
		vscode.commands.registerCommand('syncSettings.review', review),
		vscode.commands.registerCommand('syncSettings.switchProfile', switchProfile),
		vscode.commands.registerCommand('syncSettings.upload', upload),
		vscode.commands.registerCommand('syncSettings.viewDifferences', viewDifferences),
	);

	const settings = Settings.get();
	const fileChangesDelayer = new ThrottledDelayer<void>(200);
	const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.joinPath(settings.settingsUri, '..').fsPath, 'settings.yml'));

	watcher.onDidChange(() => {
		void fileChangesDelayer.trigger(async () => {
			try {
				await RepositoryFactory.reload();
			}
			catch (error: unknown) {
				Logger.error(error);
			}
		});
	});

	let crons = await setupCrons();

	vscode.workspace.onDidChangeConfiguration(async (event) => {
		if(event.affectsConfiguration('syncSettings.crons')) {
			crons.dispose();
			crons = await setupCrons();
		}
	});

	disposables.push(new vscode.Disposable(() => {
		crons.dispose();
	}));

	context.subscriptions.push(...disposables);
}
