import path from 'path';
import vscode from 'vscode';
import { Settings } from './settings.js';
import { ThrottledDelayer } from './utils/async.js';
import { getUserDataPath } from './utils/get-user-data-path.js';
import { Logger } from './utils/logger.js';

type Crons = {
	download?: string;
	review?: string;
	upload?: string;
};

const $cronsIds: Crons = {
	download: '',
	review: '',
	upload: '',
};

let $onType: vscode.Disposable | undefined;

function isOnType(value: string | undefined): boolean {
	return value?.trim().toLowerCase() === 'ontype';
}

function isInside(parent: string, filePath: string): boolean {
	const relative = path.relative(parent, filePath);

	return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function isUserSyncFile(filePath: string): boolean {
	let userDirectory: string;

	try {
		userDirectory = getUserDataPath(Settings.get());
	}
	catch {
		return false;
	}

	if(!isInside(userDirectory, filePath)) {
		return false;
	}

	const relative = path.relative(userDirectory, filePath);

	if(relative === 'settings.json' || relative === 'keybindings.json') {
		return true;
	}

	if(relative.split(path.sep)[0] !== 'snippets') {
		return false;
	}

	const extension = path.extname(filePath).toLowerCase();

	return extension === '.json' || extension === '.code-snippets';
}

function registerOnTypeUpload(): vscode.Disposable {
	const delayer = new ThrottledDelayer<void>(2_000);
	let uploading = false;
	let pending = false;

	const schedule = () => {
		void delayer.trigger(async () => {
			if(uploading) {
				pending = true;
				return;
			}

			uploading = true;

			try {
				do {
					pending = false;
					await vscode.commands.executeCommand('syncSettings.upload', { quiet: true });
				}
				while(pending);
			}
			catch (error: unknown) {
				Logger.error(error);
			}
			finally {
				uploading = false;

				if(pending) {
					schedule();
				}
			}
		});
	};

	return vscode.workspace.onDidSaveTextDocument(document => {
		if(isUserSyncFile(document.uri.fsPath)) {
			schedule();
		}
	});
}

async function registerCron(key: keyof Crons, expression: string, command: string) {
	if(isOnType(expression)) {
		if(key !== 'upload') {
			Logger.error(`syncSettings.crons.${key}: "onType" is only supported for upload`);
			return;
		}

		$onType = registerOnTypeUpload();
		return;
	}

	if(!vscode.extensions.getExtension('zokugun.cron-tasks')) {
		Logger.error(`syncSettings.crons.${key}: zokugun.cron-tasks is not installed, so the cron was not registered`);
		return;
	}

	try {
		$cronsIds[key] = await vscode.commands.executeCommand('cronTasks.register', expression, command);
	}
	catch (error: unknown) {
		Logger.error(error);
	}
}

export async function setupCrons(): Promise<vscode.Disposable> {
	$onType?.dispose();
	$onType = undefined;

	for(const key in $cronsIds) {
		if($cronsIds[key as keyof Crons]) {
			try {
				await vscode.commands.executeCommand('cronTasks.unregister', $cronsIds[key as keyof Crons]);
			}
			catch (error: unknown) {
				Logger.error(error);
			}

			$cronsIds[key as keyof Crons] = '';
		}
	}

	const config = vscode.workspace.getConfiguration('syncSettings');
	const crons = config.get<Crons>('crons') ?? {};

	if(crons.download) {
		await registerCron('download', crons.download, 'syncSettings.download');
	}

	if(crons.review) {
		await registerCron('review', crons.review, 'syncSettings.review');
	}

	if(crons.upload) {
		await registerCron('upload', crons.upload, 'syncSettings.upload');
	}

	return new vscode.Disposable(() => {
		$onType?.dispose();
		$onType = undefined;
	});
}
