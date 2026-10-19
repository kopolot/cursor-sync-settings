declare module 'node:sqlite' {
	export class DatabaseSync {
		constructor(filename: string, options?: {
			readOnly?: boolean;
			timeout?: number;
		});

		prepare(sql: string): StatementSync;
		close(): void;
	}

	export class StatementSync {
		all(namedParameters?: Record<string, unknown>): unknown[];
		run(namedParameters?: Record<string, unknown>): unknown;
	}
}
