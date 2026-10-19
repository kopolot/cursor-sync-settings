const extensionIdPattern = /^[A-Za-z0-9][A-Za-z0-9-]*\.[A-Za-z0-9][A-Za-z0-9-]*$/;

// Cursor runs its own built-ins (agent host, retrieval, socket, …) on separate
// extension hosts. They are missing from vscode.extensions.all in the user
// host without being disabled. Syncing that absence writes them into
// extensionsIdentifiers/disabled and the agent chat then times out.
export function isSyncableBuiltinId(id: string): boolean {
	if(!extensionIdPattern.test(id)) {
		return false;
	}

	const publisher = id.slice(0, id.indexOf('.')).toLowerCase();

	if(publisher === 'undefined' || publisher === 'anysphere') {
		return false;
	}

	return true;
}
