import fs from 'node:fs'
import path from 'node:path'

import type { PrismaConfigInternal } from '@prisma/config'
import {
  arg,
  checkUnsupportedDataProxy,
  Command,
  createSchemaPathInput,
  format,
  getCommandWithExecutor,
  getSchemaDatasourceProvider,
  HelpError,
  inferDirectoryConfig,
  isError,
  loadSchemaContext,
  toSchemasContainer,
  toSchemasWithConfigDir,
  validatePrismaConfigWithDatasource,
} from '@prisma/internals'
import { bold, dim, green, italic, red } from 'kleur/colors'

import { Migrate } from '../Migrate'
import { EngineResults } from '../types'
import { ensureCanConnectToDatabase, parseDatasourceInfo } from '../utils/ensureDatabaseExists'
import { printDatasource } from '../utils/printDatasource'
import { createMigration, writeMigrationLockfile, writeMigrationScript } from '../utils/createMigration'
import { listMigrations } from '../utils/listMigrations'
import { getMigrationName } from '../utils/promptForMigrationName'
import { CaptureStdout } from '../utils/captureStdout'

export class MigrateCommit implements Command {
  public static new(): MigrateCommit {
    return new MigrateCommit()
  }

  private static help = format(`
Create a new migration from changes made with prisma db push without resetting the database.

${bold('Usage')}

  ${dim('$')} prisma migrate commit [options]

  The datasource URL configuration is read from the Prisma config file (e.g., ${italic('prisma.config.ts')}).

${bold('Options')}

    -h, --help   Display this help message
      --config   Custom path to your Prisma config file
      --schema   Custom path to your Prisma schema
    -n, --name   Name the migration

${bold('Examples')}

  Commit changes made with prisma db push to a new migration
  ${dim('$')} prisma migrate commit

  Specify a name for the migration
  ${dim('$')} prisma migrate commit --name "add_users_table"

  Specify a schema
  ${dim('$')} prisma migrate commit --schema=./schema.prisma
`)

  public async parse(argv: string[], config: PrismaConfigInternal, baseDir: string): Promise<string | Error> {
    const args = arg(
      argv,
      {
        '--help': Boolean,
        '-h': '--help',
        '--name': String,
        '-n': '--name',
        '--schema': String,
        '--config': String,
        '--telemetry-information': String,
      },
      false,
    )

    if (isError(args)) {
      return this.help(args.message)
    }

    if (args['--help']) {
      return this.help()
    }

    const schemaContext = await loadSchemaContext({
      schemaPath: createSchemaPathInput({
        schemaPathFromArgs: args['--schema'],
        schemaPathFromConfig: config.schema,
        baseDir,
      }),
    })
    const { migrationsDirPath } = inferDirectoryConfig(schemaContext, config)

    const cmd = 'migrate commit'
    const validatedConfig = validatePrismaConfigWithDatasource({ config, cmd })

    checkUnsupportedDataProxy({ cmd, validatedConfig })

    printDatasource({ datasourceInfo: parseDatasourceInfo(schemaContext.primaryDatasource, validatedConfig) })

    const datasourceProvider = getSchemaDatasourceProvider(schemaContext)

    if (datasourceProvider === 'mongodb') {
      throw new Error('prisma migrate commit is not supported for MongoDB.')
    }

    await ensureCanConnectToDatabase(baseDir, validatedConfig)

    const migrate = await Migrate.setup({
      schemaEngineConfig: config,
      baseDir,
      migrationsDirPath,
      schemaContext,
      extensions: config['extensions'],
    })

    try {
      const syncResult = await migrate.engine.migrateDiff({
        from: {
          tag: 'schemaDatamodel',
          ...toSchemasContainer(schemaContext.schemaFiles),
        },
        to: {
          tag: 'schemaDatasource',
          ...toSchemasWithConfigDir(schemaContext, baseDir),
        },
        script: false,
        exitCode: true,
        filters: {
          externalTables: config.tables?.external ?? [],
          externalEnums: config.enums?.external ?? [],
        },
      })

      if (syncResult.exitCode === EngineResults.MigrateDiffExitCode.SUCCESS_NONEMPTY) {
        throw new Error(
          `Database and Prisma schema are not in sync. Run ${bold(
            green(getCommandWithExecutor('prisma db push')),
          )} first.`,
        )
      }

      const getMigrationNameResult = await getMigrationName(args['--name'])

      if (getMigrationNameResult.userCancelled) {
        process.stdout.write(getMigrationNameResult.userCancelled + '\n')
        await migrate.stop()
        process.exit(130)
      }

      const now = new Date()
      const timestamp =
        now.getUTCFullYear().toString() +
        String(now.getUTCMonth() + 1).padStart(2, '0') +
        String(now.getUTCDate()).padStart(2, '0') +
        String(now.getUTCHours()).padStart(2, '0') +
        String(now.getUTCMinutes()).padStart(2, '0') +
        String(now.getUTCSeconds()).padStart(2, '0')

      const migrationName = getMigrationNameResult.name || ''
      const generatedMigrationName = migrationName ? `${timestamp}_${migrationName}` : timestamp

      const existingMigrationPath = path.join(migrationsDirPath, generatedMigrationName)
      if (fs.existsSync(existingMigrationPath)) {
        throw new Error(`Migration directory already exists at ${existingMigrationPath}`)
      }

      const migrationsList = await listMigrations(migrationsDirPath, config.migrations?.initShadowDb ?? '')
      const hasExistingMigrations = migrationsList.migrationDirectories.length > 0

      const captureStdout = new CaptureStdout()
      captureStdout.startCapture()

      try {
        await migrate.engine.migrateDiff({
          from: hasExistingMigrations
            ? { tag: 'migrations', ...migrationsList }
            : { tag: 'empty' },
          to: {
            tag: 'schemaDatasource',
            ...toSchemasWithConfigDir(schemaContext, baseDir),
          },
          script: true,
          exitCode: null,
          filters: {
            externalTables: config.tables?.external ?? [],
            externalEnums: config.enums?.external ?? [],
          },
        })
      } finally {
        captureStdout.stopCapture()
      }

      const capturedSql = captureStdout.getCapturedText().join('\n')
      captureStdout.clearCaptureText()

      if (!capturedSql.trim()) {
        throw new Error('No changes detected since the last migration.')
      }

      if (!fs.existsSync(migrationsDirPath)) {
        fs.mkdirSync(migrationsDirPath, { recursive: true })
      }

      await createMigration({ baseDir: migrationsDirPath, generatedMigrationName })
      await writeMigrationScript({
        baseDir: migrationsDirPath,
        migrationName: generatedMigrationName,
        extension: 'sql',
        script: capturedSql,
      })
      await writeMigrationLockfile({
        baseDir: migrationsDirPath,
        connectorType: datasourceProvider,
        lockfile: { path: 'migration_lock.toml' },
      })

      await migrate.markMigrationApplied({ migrationId: generatedMigrationName })

      process.stdout.write(`\nMigration ${generatedMigrationName} created and marked as applied.\n`)
    } finally {
      await migrate.stop()
    }

    return ``
  }

  public help(error?: string): string | HelpError {
    if (error) {
      return new HelpError(`\n${bold(red(`!`))} ${error}\n${MigrateCommit.help}`)
    }
    return MigrateCommit.help
  }
}
