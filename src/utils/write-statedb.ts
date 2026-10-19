import path from 'path';
import { DatabaseSync } from 'node:sqlite';

function resolveDatabasePath(userDataPathOrDatabase: string): string {
	if(userDataPathOrDatabase.endsWith('state.vscdb')) {
		return userDataPathOrDatabase;
	}

	return path.join(userDataPathOrDatabase, 'globalStorage', 'state.vscdb');
}

// In-place update. Rewriting the file the way sql.js does would load all of
// Cursor's multi-gigabyte state.vscdb and then replace it.
export async function writeStateDB(userDataPath: string, query: string, args?: Record<string, any>): Promise<void> {
	const database = new DatabaseSync(resolveDatabasePath(userDataPath), {
		timeout: 30_000,
	});

	try {
		const statement = database.prepare(query);

		if(args) {
			statement.run(args);
		}
		else {
			statement.run();
		}
	}
	finally {
		database.close();
	}
}
