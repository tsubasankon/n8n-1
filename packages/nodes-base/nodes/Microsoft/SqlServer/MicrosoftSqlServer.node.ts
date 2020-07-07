import { IExecuteFunctions } from 'n8n-core';
import {
	IDataObject,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription
} from 'n8n-workflow';

import { chunk, flatten } from '../../utils/utilities';

import * as mssql from 'mssql';

import { ITable } from './TableInterface';

import {
	copyInputItems,
	createTableStruct,
	executeQueryQueue,
	extractDeleteValues,
	extractUpdateCondition,
	extractUpdateSet,
	extractValues
} from './GenericFunctions';

export class MicrosoftSqlServer implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Microsoft SQL Server',
		name: 'microsoftSqlServer',
		icon: 'file:mssql.png',
		group: ['input'],
		version: 1,
		description: 'Gets, add and update data in Microsoft SQL Server.',
		defaults: {
			name: 'Microsoft SQL Server',
			color: '#1d4bab'
		},
		inputs: ['main'],
		outputs: ['main'],
		credentials: [
			{
				name: 'microsoftSqlServer',
				required: true
			}
		],
		properties: [
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				options: [
					{
						name: 'Execute Query',
						value: 'executeQuery',
						description: 'Executes a SQL query.'
					},
					{
						name: 'Insert',
						value: 'insert',
						description: 'Insert rows in database.'
					},
					{
						name: 'Update',
						value: 'update',
						description: 'Updates rows in database.'
					},
					{
						name: 'Delete',
						value: 'delete',
						description: 'Deletes rows in database.'
					}
				],
				default: 'insert',
				description: 'The operation to perform.'
			},

			// ----------------------------------
			//         executeQuery
			// ----------------------------------
			{
				displayName: 'Query',
				name: 'query',
				type: 'string',
				typeOptions: {
					rows: 5
				},
				displayOptions: {
					show: {
						operation: ['executeQuery']
					}
				},
				default: '',
				placeholder: 'SELECT id, name FROM product WHERE id < 40',
				required: true,
				description: 'The SQL query to execute.'
			},

			// ----------------------------------
			//         insert
			// ----------------------------------
			{
				displayName: 'Table',
				name: 'table',
				type: 'string',
				displayOptions: {
					show: {
						operation: ['insert']
					}
				},
				default: '',
				required: true,
				description: 'Name of the table in which to insert data to.'
			},
			{
				displayName: 'Columns',
				name: 'columns',
				type: 'string',
				displayOptions: {
					show: {
						operation: ['insert']
					}
				},
				default: '',
				placeholder: 'id,name,description',
				description:
					'Comma separated list of the properties which should used as columns for the new rows.'
			},

			// ----------------------------------
			//         update
			// ----------------------------------
			{
				displayName: 'Table',
				name: 'table',
				type: 'string',
				displayOptions: {
					show: {
						operation: ['update']
					}
				},
				default: '',
				required: true,
				description: 'Name of the table in which to update data in'
			},
			{
				displayName: 'Update Key',
				name: 'updateKey',
				type: 'string',
				displayOptions: {
					show: {
						operation: ['update']
					}
				},
				default: 'id',
				required: true,
				description:
					'Name of the property which decides which rows in the database should be updated. Normally that would be "id".'
			},
			{
				displayName: 'Columns',
				name: 'columns',
				type: 'string',
				displayOptions: {
					show: {
						operation: ['update']
					}
				},
				default: '',
				placeholder: 'name,description',
				description:
					'Comma separated list of the properties which should used as columns for rows to update.'
			},

			// ----------------------------------
			//         delete
			// ----------------------------------
			{
				displayName: 'Table',
				name: 'table',
				type: 'string',
				displayOptions: {
					show: {
						operation: ['delete']
					}
				},
				default: '',
				required: true,
				description: 'Name of the table in which to delete data.'
			},
			{
				displayName: 'Delete Key',
				name: 'deleteKey',
				type: 'string',
				displayOptions: {
					show: {
						operation: ['delete']
					}
				},
				default: 'id',
				required: true,
				description:
					'Name of the property which decides which rows in the database should be deleted. Normally that would be "id".'
			}
		]
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const credentials = this.getCredentials('microsoftSqlServer');

		if (credentials === undefined) {
			throw new Error('No credentials got returned!');
		}

		const config = {
			server: credentials.server as string,
			port: credentials.port as number,
			database: credentials.database as string,
			user: credentials.user as string,
			password: credentials.password as string,
			domain: credentials.domain ? (credentials.domain as string) : undefined
		};

		const pool = new mssql.ConnectionPool(config);
		await pool.connect();

		let returnItems: any = [];

		const items = this.getInputData();
		const operation = this.getNodeParameter('operation', 0) as string;

		try {
			if (operation === 'executeQuery') {
				// ----------------------------------
				//         executeQuery
				// ----------------------------------

				const rawQuery = this.getNodeParameter('query', 0) as string;

				const queryResult = await pool.request().query(rawQuery);

				const result =
					queryResult.recordsets.length > 1
						? flatten(queryResult.recordsets)
						: queryResult.recordsets[0];

				returnItems = this.helpers.returnJsonArray(result as IDataObject[]);
			} else if (operation === 'insert') {
				// ----------------------------------
				//         insert
				// ----------------------------------

				const tables = createTableStruct(items, this.getNodeParameter);
				const queriesResults = await executeQueryQueue(
					tables,
					({
						table,
						columnString,
						columns,
						items
					}: {
						table: string;
						columnString: string;
						columns: string[];
						items: INodeExecutionData[];
					}): Promise<any>[] => {
						const insertValuesList = chunk(
							copyInputItems(items, columns),
							1000
						);

						return insertValuesList.map(insertValues => {
							const values = insertValues
								.map((item: IDataObject) => extractValues(item))
								.join(',');

							return pool
								.request()
								.query(
									`INSERT INTO ${table}(${columnString}) VALUES ${values};`
								);
						});
					}
				);

				const rowsAffected = flatten(queriesResults).reduce(
					(acc: number, resp: mssql.IResult<object>): number =>
						(acc += resp.rowsAffected.reduce((sum, val) => (sum += val))),
					0
				);

				returnItems = this.helpers.returnJsonArray({
					rowsAffected
				} as IDataObject);
			} else if (operation === 'update') {
				// ----------------------------------
				//         update
				// ----------------------------------

				const updateKeys = items.map(
					(item, index) => this.getNodeParameter('updateKey', index) as string
				);
				const tables = createTableStruct(
					items,
					this.getNodeParameter,
					'updateKey'
				);
				const queriesResults = await executeQueryQueue(
					tables,
					({
						table,
						columns,
						items
					}: {
						table: string;
						columns: string[];
						items: INodeExecutionData[];
					}): Promise<any>[] => {
						const updateItems = copyInputItems(
							items,
							['updateKey'].concat(updateKeys).concat(columns)
						);
						return updateItems.map(item => {
							const setValues = extractUpdateSet(item, columns);
							const condition = extractUpdateCondition(
								item,
								item.updateKey as string
							);

							return pool
								.request()
								.query(`UPDATE ${table} SET ${setValues} WHERE ${condition};`);
						});
					}
				);

				const rowsAffected = flatten(queriesResults).reduce(
					(acc: number, resp: mssql.IResult<object>): number =>
						(acc += resp.rowsAffected.reduce((sum, val) => (sum += val))),
					0
				);

				returnItems = this.helpers.returnJsonArray({
					rowsAffected
				} as IDataObject);
			} else if (operation === 'delete') {
				// ----------------------------------
				//         delete
				// ----------------------------------

				const tables = items.reduce((tables, item, index) => {
					const table = this.getNodeParameter('table', index) as string;
					const deleteKey = this.getNodeParameter('deleteKey', index) as string;
					if (tables[table] === undefined) {
						tables[table] = {};
					}
					if (tables[table][deleteKey] === undefined) {
						tables[table][deleteKey] = [];
					}
					tables[table][deleteKey].push(item);
					return tables;
				}, {} as ITable);

				const queriesResults = await Promise.all(
					Object.keys(tables).map(table => {
						const deleteKeyResults = Object.keys(tables[table]).map(
							deleteKey => {
								const deleteItemsList = chunk(
									copyInputItems(tables[table][deleteKey], [deleteKey]),
									1000
								);
								const queryQueue = deleteItemsList.map(deleteValues => {
									return pool
										.request()
										.query(
											`DELETE FROM ${table} WHERE ${deleteKey} IN ${extractDeleteValues(
												deleteValues,
												deleteKey
											)};`
										);
								});
								return Promise.all(queryQueue);
							}
						);
						return Promise.all(deleteKeyResults);
					})
				);

				const rowsAffected = flatten(queriesResults).reduce(
					(acc: number, resp: mssql.IResult<object>): number =>
						(acc += resp.rowsAffected.reduce((sum, val) => (sum += val))),
					0
				);

				returnItems = this.helpers.returnJsonArray({
					rowsAffected
				} as IDataObject);
			} else {
				await pool.close();
				throw new Error(`The operation "${operation}" is not supported!`);
			}
		} catch (err) {
			if (this.continueOnFail() === true) {
				returnItems = this.helpers.returnJsonArray({
					error: err
				} as IDataObject);
			} else {
				await pool.close();
				throw err;
			}
		}

		// Close the connection
		await pool.close();

		return this.prepareOutputData(returnItems);
	}
}