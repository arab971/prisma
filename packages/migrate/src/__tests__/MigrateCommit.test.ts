import { MigrateCommit } from '../commands/MigrateCommit'
import { describeMatrix, sqliteOnly } from './__helpers__/conditionalTests'
import { createDefaultTestContext } from './__helpers__/context'

const ctx = createDefaultTestContext()

describe('prisma.config.ts', () => {
  it('should require a datasource in the config', async () => {
    ctx.fixture('no-config')

    const result = MigrateCommit.new().parse([], await ctx.config(), ctx.configDir())
    await expect(result).rejects.toThrowErrorMatchingInlineSnapshot(
      `"The datasource.url property is required in your Prisma config file when using prisma migrate commit."`,
    )
  })
})

describe('common', () => {
  it('should fail if no schema file', async () => {
    ctx.fixture('empty')
    const result = MigrateCommit.new().parse([], await ctx.config(), ctx.configDir())
    await expect(result).rejects.toThrowErrorMatchingInlineSnapshot(`
      "Could not find Prisma Schema that is required for this command.
      You can either provide it with \`--schema\` argument,
      set it in your Prisma Config file (e.g., \`prisma.config.ts\`),
      set it as \`prisma.schema\` in your package.json,
      or put it into the default location (\`./prisma/schema.prisma\`, or \`./schema.prisma\`.
      Checked following paths:

      schema.prisma: file not found
      prisma/schema.prisma: file not found

      See also https://pris.ly/d/prisma-schema-location"
    `)
  })

  it('should fail for MongoDB', async () => {
    ctx.fixture('schema-only-mongodb')
    ctx.setDatasource({ url: 'mongodb://localhost:27017/test' })
    const result = MigrateCommit.new().parse([], await ctx.config(), ctx.configDir())
    await expect(result).rejects.toThrowErrorMatchingInlineSnapshot(
      `"prisma migrate commit is not supported for MongoDB."`,
    )
  })
})

describeMatrix(sqliteOnly, 'SQLite', () => {
  it('should fail if schema and DB are out of sync', async () => {
    ctx.fixture('baseline-sqlite')
    const result = MigrateCommit.new().parse([], await ctx.config(), ctx.configDir())
    await expect(result).rejects.toThrowErrorMatchingInlineSnapshot(
      `"Database and Prisma schema are not in sync. Run prisma db push first."`,
    )
  })

  it('should create and commit a baseline migration', async () => {
    ctx.fixture('baseline-sqlite')
    ctx.setConfigFile('schema-with-blog.config.ts')
    const result = MigrateCommit.new().parse(['--name', 'init'], await ctx.config(), ctx.configDir())
    await expect(result).resolves.toMatchInlineSnapshot(`""`)
    expect(ctx.normalizedCapturedStdout()).toContain('created and marked as applied')
  })

  it('should fail if no changes since last migration', async () => {
    ctx.fixture('existing-db-1-migration')
    const result = MigrateCommit.new().parse([], await ctx.config(), ctx.configDir())
    await expect(result).rejects.toThrowErrorMatchingInlineSnapshot(
      `"No changes detected since the last migration."`,
    )
  })
})
