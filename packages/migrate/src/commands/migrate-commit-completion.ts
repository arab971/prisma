import { completionConfigPaths, completionSchemaPaths } from '@prisma/internals/src/cli/completion-values'
import type { CommandCompletion } from '@prisma/internals/src/cli/types'

export const migrateCommitCompletion: CommandCompletion = {
  name: 'migrate commit',
  description: 'Commit changes made with prisma db push to a new migration',
  options: [
    { name: 'help', alias: 'h', description: 'Display this help message' },
    { name: 'schema', description: 'Custom path to your Prisma schema', values: completionSchemaPaths },
    { name: 'config', description: 'Custom path to your Prisma config file', values: completionConfigPaths },
    { name: 'name', alias: 'n', description: 'Name the migration' },
  ],
}
