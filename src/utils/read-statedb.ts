import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { exists } from './exists.js';

export type StateValue = string | number | null | Uint8Array;

export type StateQueryResult = {
	columns: string[];
	values: any[][];
};

function asStateValue(value: unknown): any {
	if(Buffer.isBuffer(value) || value instanceof Uint8Array) {
		return Buffer.from(value).toString('utf8');
	}

	return value ?? null;
}

function resolveDatabasePath(userDataPathOrDatabase: string): string {
	if(userDataPathOrDatabase.endsWith('state.vscdb')) {
		return userDataPathOrDatabase;
	}

	return path.join(userDataPathOrDatabase, 'globalStorage', 'state.vscdb');
}

// sql.js reads the whole state.vscdb into one Buffer. Cursor's database is
// larger than Node's 2 GiB string/buffer limit (ERR_FS_FILE_TOO_LARGE) because
// agent transcripts live in it. Query SQLite directly and keep only the rows
// the caller asked for.
export async function readStateDB(userDataPath: string, query: string, args?: Record<string, any>): Promise<StateQueryResult | undefined> {
	const databasePath = resolveDatabasePath(userDataPath);

	if(!(await exists(databasePath))) {
		return undefined;
	}

	const database = new DatabaseSync(databasePath, {
		readOnly: true,
		timeout: 30_000,
	});

	try {
		const statement = database.prepare(query);
		const rows = args ? statement.all(args) : statement.all();

		if(rows.length === 0) {
			return undefined;
		}

		const columns = Object.keys(rows[0] as Record<string, unknown>);

		return {
			columns,
			values: rows.map(row => columns.map(column => asStateValue((row as Record<string, unknown>)[column]))),
		};
	}
	finally {
		database.close();
	}
}
