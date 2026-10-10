export const axdbSqlTool = {
  name: 'axdb_sql',
  description: 'Read-only live AxDB SQL on the dev VM. Fetch contract first.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['contract', 'status', 'schema', 'query'] },
    },
    required: ['action'], // additional properties allowed; strict parameters come from contract
  },
};
