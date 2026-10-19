import path from 'path';
import fse from 'fs-extra';
import vscode from 'vscode';
import { readStateDB } from './read-statedb.js';
import { writeStateDB } from './write-statedb.js';

// Cursor keeps the visible primary sidebar in the workspace state database.
// workbench.sideBar.position 0 is left and 1 is right. The agent-layout key is
// the opposite side from that primary bar. The running window applies that pair
// through workbench.action.toggleSidebarPosition. moveSideBarLeft/Right write
// workbench.sideBar.location into settings.json and are not used here.
const workspaceLayoutKeys = [
	'workbench.sideBar.position',
	'workbench.sideBar.hidden',
	'workbench.unifiedSidebar.hidden',
	'cursor/agentLayout.sidebarLocation',
	'cursor/agentLayout.sidebarVisible',
	'cursor/editorLayout.sidebarVisible',
];

export function isCursorWorkspaceLayoutKey(key: string): boolean {
	return workspaceLayoutKeys.includes(key);
}

export async function readCursorLayout(userDataPath: string): Promise<Record<string, string>> {
	const properties: Record<string, string> = {};
	const databasePath = await findWorkspaceStatePath(userDataPath);

	if(!databasePath) {
		return properties;
	}

	const data = await readStateDB(databasePath, `SELECT key, value FROM ItemTable WHERE key IN (${quoted(workspaceLayoutKeys)})`);

	for(const [key, value] of data?.values ?? []) {
		if(value !== null && value !== undefined) {
			properties[String(key)] = String(value);
		}
	}

	return properties;
}

export function shouldToggleSidebar(current: string | undefined, desired: unknown): boolean {
	if(desired !== '0' && desired !== '1') {
		return false;
	}

	// Missing key means we do not know the in-memory side. One blind toggle
	// would move the bar the wrong way.
	if(current === undefined) {
		return false;
	}

	return current !== desired;
}

export async function restoreCursorLayout(userDataPath: string, profile: Record<string, unknown>): Promise<void> {
	const databasePath = await findWorkspaceStatePath(userDataPath);
	const desired = profile['workbench.sideBar.position'];
	// Read before the write. One toggle only when the saved side differs.
	// A second toggle was only there to measure the bar, and it moved it twice.
	const current = databasePath ? await readSidebarPosition(databasePath) : undefined;

	if(shouldToggleSidebar(current, desired)) {
		await vscode.commands.executeCommand('workbench.action.toggleSidebarPosition');
	}

	if(!databasePath) {
		return;
	}

	const values: string[] = [];
	const args: Record<string, string> = {};
	let index = 0;

	for(const key of workspaceLayoutKeys) {
		const value = profile[key];

		if(typeof value !== 'string') {
			continue;
		}

		values.push(`'${key}', $${index}`);
		args[`$${index}`] = value;
		++index;
	}

	if(index > 0) {
		await writeStateDB(databasePath, `INSERT OR REPLACE INTO ItemTable (key, value) VALUES (${values.join('), (')})`, args);
	}
}

async function findWorkspaceStatePath(userDataPath: string): Promise<string | undefined> {
	const folders = vscode.workspace.workspaceFolders ?? [];
	const workspaceFile = vscode.workspace.workspaceFile;

	if(folders.length === 0 && !workspaceFile) {
		return undefined;
	}

	const root = path.join(userDataPath, 'workspaceStorage');

	if(!(await fse.pathExists(root))) {
		return undefined;
	}

	let best: { databasePath: string; rank: number } | undefined;

	for(const entry of await fse.readdir(root)) {
		const marker = path.join(root, entry, 'workspace.json');

		if(!(await fse.pathExists(marker))) {
			continue;
		}

		try {
			const data = JSON.parse(await fse.readFile(marker, 'utf8')) as { folder?: string; workspace?: string };
			const databasePath = path.join(root, entry, 'state.vscdb');

			if(!(await fse.pathExists(databasePath))) {
				continue;
			}

			const rank = workspaceRank(data, workspaceFile, folders);

			if(rank === undefined) {
				continue;
			}

			if(!best || rank > best.rank) {
				best = { databasePath, rank };
			}
		}
		catch {
			// ignore a workspace marker that is not JSON
		}
	}

	return best?.databasePath;
}

function workspaceRank(data: { folder?: string; workspace?: string }, workspaceFile: vscode.Uri | undefined, folders: readonly vscode.WorkspaceFolder[]): number | undefined {
	if(workspaceFile) {
		return data.workspace && matchesSaved(data.workspace, uriForms(workspaceFile)) ? 2 : undefined;
	}

	if(!data.folder) {
		return undefined;
	}

	const primary = folders[0];

	if(primary && matchesSaved(data.folder, uriForms(primary.uri))) {
		return 1;
	}

	for(const folder of folders.slice(1)) {
		if(matchesSaved(data.folder, uriForms(folder.uri))) {
			return 0;
		}
	}

	return undefined;
}

function uriForms(uri: vscode.Uri): string[] {
	return [uri.toString(), uri.toString(true), uri.fsPath];
}

function matchesSaved(saved: string, forms: readonly string[]): boolean {
	const wanted = new Set(forms.map(canonicalUri));

	return wanted.has(canonicalUri(saved));
}

function canonicalUri(value: string): string {
	let text = value.trim();

	try {
		text = decodeURI(text);
	}
	catch {
		// keep the raw text when the percent-encoding is broken
	}

	if(text.startsWith('file://')) {
		text = text.slice('file://'.length);
	}

	if(text.length > 1) {
		text = text.replace(/\/+$/, '');
	}

	return text;
}

async function readSidebarPosition(databasePath: string): Promise<string | undefined> {
	const data = await readStateDB(databasePath, 'SELECT value FROM ItemTable WHERE key = \'workbench.sideBar.position\'');
	const value = data?.values?.[0]?.[0];

	if(value === undefined || value === null) {
		return undefined;
	}

	return String(value);
}

function quoted(keys: string[]): string {
	return keys.map(key => `'${key}'`).join(', ');
}
